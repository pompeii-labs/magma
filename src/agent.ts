import {
	AssistantModelMessage,
	CallSettings,
	LanguageModel,
	ModelMessage,
	streamText,
	ToolModelMessage,
	ToolSet,
	UserModelMessage
} from "ai";
import {
	MagmaAssistantMessage,
	MagmaMiddlewareSet,
	MagmaStreamChunk,
	MagmaSystemMessage,
	MagmaToolResultMessage,
	MagmaToolSet,
	MagmaUsage,
	MagmaUserMessage,
	TraceEvent
} from "./types";
import { parseErrorToError, parseErrorToString } from "./helpers";
import { runPreCompletionMiddleware } from "./middleware/preCompletion";
import { runOnCompletionMiddleware } from "./middleware/onCompletion";
import { runPreToolExecutionMiddleware } from "./middleware/preToolExecution";
import { executeTools } from "./tools/execute";
import { runOnToolExecutionMiddleware } from "./middleware/onToolExecution";
import { runOnMainFinishMiddleware } from "./middleware/onMainFinish";

export type MagmaCtx = {
	middlewareRetries: {
		[id: string]: number;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
};

export type MagmaLLMConfig = {
	general?: CallSettings;
	model: LanguageModel;
};

export type MagmaAgentProps<STATE, TOOLS extends MagmaToolSet<STATE>> = {
	state: STATE;
	llmConfig: MagmaLLMConfig;
	getSystemPrompts?: (state: STATE) => MagmaSystemMessage[];
	tools?: TOOLS;
	middleware?: MagmaMiddlewareSet<STATE, TOOLS>;

	messageContext?: number;
	maxMiddlewareRetries?: number;
	onUsageUpdate?: (usage: MagmaUsage) => void;
	onError?: (error: Error) => void;

	verbose?: boolean;
};

export class MagmaAgent<STATE, TOOLS extends MagmaToolSet<STATE>> implements MagmaAgentProps<
	STATE,
	TOOLS
> {
	state: STATE;
	llmConfig: MagmaLLMConfig;
	getSystemPrompts: (state: STATE) => MagmaSystemMessage[];
	tools: TOOLS;
	middleware: MagmaMiddlewareSet<STATE, TOOLS>;

	messageContext: number;
	maxMiddlewareRetries: number;
	onUsageUpdate: (usage: MagmaUsage) => void;
	onError: (error: Error) => void;

	verbose?: boolean;

	messages: ModelMessage[];

	private abortControllers: Map<string, AbortController>;

	constructor(
		props: Omit<MagmaAgentProps<STATE, TOOLS>, "tools" | "middleware">,
		tools?: TOOLS,
		middleware?: MagmaMiddlewareSet<STATE, TOOLS>
	) {
		this.state = props.state;
		this.llmConfig = props.llmConfig;

		this.getSystemPrompts = props.getSystemPrompts ?? (() => []);
		this.tools = (tools ?? {}) as TOOLS;
		this.middleware = (middleware ?? {}) as MagmaMiddlewareSet<STATE, TOOLS>;

		this.messageContext = props.messageContext ?? -1;
		this.maxMiddlewareRetries = props.maxMiddlewareRetries ?? 5;
		this.onUsageUpdate = props.onUsageUpdate ?? (() => {});
		this.onError =
			props.onError ??
			((error) => {
				console.error(parseErrorToString(error));
			});

		this.verbose = props.verbose;

		this.messages = [];

		this.abortControllers = new Map();

		this.log("Agent initialized");
	}

	public log(message: string): void {
		if (this.verbose) {
			console.log(message);
		}
	}

	public async main(args: {
		config?: {
			general?: CallSettings;
		};
		userMessage: MagmaUserMessage;
		onTrace?: (trace: TraceEvent[]) => void;
		trigger?: undefined;
		ctx?: MagmaCtx;
		onStreamChunk?: (chunk: MagmaStreamChunk, options: { state: STATE }) => void;
	}): Promise<MagmaAssistantMessage | null>;

	public async main(args: {
		config?: {
			general?: CallSettings;
		};
		userMessage: MagmaUserMessage;
		onTrace?: (trace: TraceEvent[]) => void;
		trigger: keyof TOOLS;
		ctx?: MagmaCtx;
		onStreamChunk?: (chunk: MagmaStreamChunk, options: { state: STATE }) => void;
	}): Promise<MagmaToolResultMessage | null>;

	public async main(args: {
		config?: {
			general?: CallSettings;
		};
		userMessage: MagmaUserMessage;
		onTrace?: (trace: TraceEvent[]) => void;
		trigger?: keyof TOOLS;
		ctx?: MagmaCtx;
		onStreamChunk?: (chunk: MagmaStreamChunk, options: { state: STATE }) => void;
	}): Promise<MagmaAssistantMessage | MagmaToolResultMessage | null> {
		return (await this._main({
			config: args.config,
			userOrToolMessage: args.userMessage,
			onTrace: args.onTrace,
			trigger: args.trigger,
			ctx: args.ctx,
			onStreamChunk: args.onStreamChunk
		})) as MagmaToolResultMessage | null;
	}

	private async _main(args: {
		config?: {
			general?: CallSettings;
		};
		userOrToolMessage: UserModelMessage | ToolModelMessage;
		trigger?: keyof TOOLS;
		originIndex?: number;
		messages?: Array<ModelMessage>;
		trace?: TraceEvent[];
		onTrace?: (trace: TraceEvent[]) => void;
		ctx?: MagmaCtx;
		onStreamChunk?: (chunk: MagmaStreamChunk, options: { state: STATE }) => void;
	}): Promise<AssistantModelMessage | MagmaToolResultMessage | null> {
		const {
			config,
			trace = [],
			onTrace,
			userOrToolMessage,
			trigger,
			ctx = { middlewareRetries: {} },
			onStreamChunk = () => {}
		} = args;
		let originIndex = args.originIndex;
		const localMessages = [
			...(args?.messages ?? this.messages.filter((m) => m.role !== "system"))
		];

		const requestId = Math.random().toString(36).substring(2, 15);
		try {
			// this promise will resolve when either main finishes or the abort controller is aborted
			const mainPromise = new Promise<AssistantModelMessage | ToolModelMessage | null>(
				// eslint-disable-next-line no-async-promise-executor
				async (resolve, reject) => {
					try {
						const abortController = new AbortController();
						this.abortControllers.set(requestId, abortController);
						abortController.signal.onabort = () => {
							this.abortControllers.delete(requestId);
							this.log(`Abort signal received for request ${requestId}`);
							return resolve(null);
						};

						// Save the index of the newest user message
						const userOrToolMessageIndex: number = localMessages.length;
						if (originIndex === undefined) originIndex = userOrToolMessageIndex;
						localMessages.push(userOrToolMessage);

						// Run the preCompletion middleware
						let preCompletionMiddlewareResult: UserModelMessage | ToolModelMessage;

						if (userOrToolMessage.role === "user") {
							// user message, so we run preCompletion middleware
							try {
								preCompletionMiddlewareResult = await runPreCompletionMiddleware({
									agent: this,
									middleware: this.middleware,
									message: userOrToolMessage as UserModelMessage,
									trace,
									requestId
								});
							} catch (error) {
								// If the preCompletion middleware fails, we should remove the last message
								localMessages.pop();

								// Return the error message as a tool result if we are in trigger mode
								if (trigger !== undefined) {
									this.log(
										"Resolving error message as tool call due to trigger being specified"
									);
									return resolve({
										role: "tool",
										content: [
											{
												type: "tool-result",
												toolCallId: "N/A",
												toolName: "N/A",
												output: {
													type: "error-text",
													value: parseErrorToString(error)
												}
											}
										]
									});
								}

								// Return the error message as the assistant message if we are not in trigger mode
								this.log("Resolving error message as assistant message");
								return resolve({
									role: "assistant",
									content: parseErrorToString(error)
								});
							}
						} else {
							// tool result message, so we don't need to run preCompletion middleware
							preCompletionMiddlewareResult = userOrToolMessage as ToolModelMessage;
						}

						// Update the last user message with the result of the preCompletion middleware
						localMessages[userOrToolMessageIndex] = preCompletionMiddlewareResult;

						// Determine the config to be used for this request
						const configToUse = config ?? this.llmConfig;

						// based on the slice, these are the message we should use for the completion
						const completionMessages =
							this.messageContext === -1
								? localMessages
								: localMessages.slice(-this.messageContext);

						const toolsArray = Object.entries(this.tools);
						let enabledToolsArray = toolsArray.filter(([_, tool]) =>
							"enabled" in tool && tool.enabled ? tool.enabled(this.state) : true
						);

						if (trigger !== undefined) {
							enabledToolsArray = enabledToolsArray.filter(
								([name]) => name === trigger
							);

							if (enabledToolsArray.length === 0) {
								this.log(
									`No enabled tool matched "${trigger.toString()}", resolving null`
								);
								return resolve(null);
							}
						}

						const finalToolsArray = enabledToolsArray.map(([name, tool]) => [
							name,
							{ ...tool, execute: undefined, enabled: undefined }
						]);

						const tools = Object.fromEntries(finalToolsArray) as ToolSet;

						// get the completion
						// we will always use a stream, and only use the onStreamChunk callback if stream mode is active
						const { fullStream, content, totalUsage } = streamText({
							model: this.llmConfig.model,
							tools: tools,
							messages: [...this.getSystemPrompts(this.state), ...completionMessages],
							abortSignal: this.abortControllers.get(requestId)?.signal,
							...configToUse.general
						});

						// Ensure the abort controller is still active
						if (!this.abortControllers.has(requestId)) {
							this.log(
								`No matching abort controller found for ${requestId} after streamText call, resolving null`
							);
							return resolve(null);
						}

						for await (const chunk of fullStream) {
							onStreamChunk(chunk as MagmaStreamChunk, { state: this.state });
						}

						// create the Asisstant message from the completion
						const completion = {
							role: "assistant",
							content: await content
						} as AssistantModelMessage;

						// Call the onUsageUpdate callback
						this.onUsageUpdate(await totalUsage);

						// Add the completion message to the messages array
						localMessages.push({
							role: "assistant",
							content: await content
						} as AssistantModelMessage);

						// Run the onCompletion middleware
						// this will only affect text content from the assistant
						let onCompletionMiddlewareResult: AssistantModelMessage | null;
						try {
							onCompletionMiddlewareResult = await runOnCompletionMiddleware({
								agent: this,
								middleware: this.middleware,
								message: completion,
								trace,
								requestId,
								ctx
							});
						} catch (error) {
							// If the onCompletion middleware fails, we should remove the last message
							// This is the failing assistant message
							localMessages.pop();

							// We should also remove the user message, as it will be re-added in the subsequent main call
							localMessages.pop();

							// Add the error message to the messages array
							localMessages.push({
								role: "system",
								content: parseErrorToString(error)
							});

							// Trigger another completion with the error message as context
							return resolve(
								await this._main({
									config: configToUse,
									messages: localMessages,
									userOrToolMessage,
									trigger,
									originIndex,
									trace,
									onTrace,
									ctx,
									onStreamChunk
								})
							);
						}

						// If the onCompletion middleware returns null
						// That means it failed to meet the middleware requirements in ${this.maxMiddlewareRetries} attempts
						if (!onCompletionMiddlewareResult) {
							throw new Error(
								`Catastrophic error: failed onCompletion middleware ${this.maxMiddlewareRetries} times`
							);
						}

						// Update the last message with the result of the onCompletion middleware
						localMessages[localMessages.length - 1] = onCompletionMiddlewareResult;

						// If the onCompletion middleware returns a tool call, we should execute the tools

						let onToolExecutionMiddlewareResult: ToolModelMessage | null;
						if (
							typeof onCompletionMiddlewareResult.content !== "string" &&
							onCompletionMiddlewareResult.content.filter(
								(c) => c.type === "tool-call"
							).length > 0 &&
							onCompletionMiddlewareResult.content.filter(
								(c) => c.type === "tool-result"
							).length === 0
						) {
							let preToolExecutionMiddlewareResult: AssistantModelMessage | null;
							try {
								preToolExecutionMiddlewareResult =
									await runPreToolExecutionMiddleware({
										agent: this,
										middleware: this.middleware,
										message: onCompletionMiddlewareResult,
										trace,
										requestId,
										ctx
									});
							} catch (error) {
								// Remove the failing tool call message
								localMessages.pop();

								// Remove the user message, as it will be readded in the subsequent main call
								localMessages.pop();

								localMessages.push({
									role: "system",
									content: parseErrorToString(error)
								});

								return resolve(
									await this._main({
										config: configToUse,
										messages: localMessages,
										userOrToolMessage,
										trigger,
										originIndex,
										trace,
										onTrace,
										ctx,
										onStreamChunk
									})
								);
							}

							if (!preToolExecutionMiddlewareResult) {
								throw new Error(
									`Catastrophic error: failed preToolExecution middleware ${this.maxMiddlewareRetries} times`
								);
							}

							// Update the last message with the result of the onCompletion middleware
							localMessages[localMessages.length - 1] =
								preToolExecutionMiddlewareResult;

							// Execute the tools
							const toolResultMessage = await executeTools({
								agent: this,
								state: this.state,
								tools: this.tools,
								message: preToolExecutionMiddlewareResult,
								trace,
								requestId
							});

							onToolExecutionMiddlewareResult = await runOnToolExecutionMiddleware({
								agent: this,
								middleware: this.middleware,
								message: toolResultMessage,
								trace,
								requestId
							});

							// If the abort controller is not active, return null
							if (!this.abortControllers.has(requestId)) {
								this.log(
									`No matching abort controller found for ${requestId} after onToolExecutionMiddleware, resolving null`
								);
								return resolve(null);
							}

							// if we are in trigger mode, the resolve the tool result
							if (trigger !== undefined) {
								this.log(
									`Resolving tool result due to trigger mode being specified`
								);
								return resolve(onToolExecutionMiddlewareResult);
							}

							// Trigger another completion with the tool result because last message was a tool call and we are not in trigger mode
							return resolve(
								await this._main({
									config: configToUse,
									messages: localMessages,
									userOrToolMessage: onToolExecutionMiddlewareResult,
									trigger,
									originIndex,
									trace,
									onTrace,
									ctx,
									onStreamChunk
								})
							);
						}

						// If the onCompletion middleware does not return a tool call, we should run the onMainFinish middleware
						let onMainFinishMiddlewareResult: AssistantModelMessage | null;
						try {
							onMainFinishMiddlewareResult = await runOnMainFinishMiddleware({
								agent: this,
								middleware: this.middleware,
								message: onCompletionMiddlewareResult,
								trace,
								requestId,
								ctx
							});
						} catch (error) {
							// If the onMainFinish middleware fails, we should remove the offending message
							localMessages.pop();

							// Also remove the message before as it will be re-added in the subsequent main call
							localMessages.pop();

							// Add the error message to the messages array
							localMessages.push({
								role: "system",
								content: parseErrorToString(error)
							});

							return resolve(
								await this._main({
									config: configToUse,
									messages: localMessages,
									userOrToolMessage,
									trigger,
									originIndex,
									trace,
									onTrace,
									ctx,
									onStreamChunk
								})
							);
						}

						if (!onMainFinishMiddlewareResult) {
							throw new Error(
								`Catastrophic error: failed onMainFinish middleware ${this.maxMiddlewareRetries} times`
							);
						}

						// We don't update the last message with the result of the onMainFinish middleware
						// Returning from onMainFinish will update the main output, but not the message history

						// Call trace callback if provided
						if (onTrace) {
							onTrace([...trace]);
						}

						// update the main agent message history
						this.messages.push(...localMessages.slice(originIndex));

						return resolve(onMainFinishMiddlewareResult);
					} catch (error) {
						return reject(error);
					}
				}
			);

			return await mainPromise;
		} catch (error) {
			// Call trace callback even on error
			if (onTrace) {
				onTrace([...trace]);
			}

			try {
				this.log(`Main loop failed: ${parseErrorToString(error)}`);
				this.onError(parseErrorToError(error));
				return null;
			} catch {
				throw error;
			}
		} finally {
			this.abortControllers.delete(requestId);
		}
	}

	/**
	 * Stops the currently executing request.
	 * @returns true if a request was killed, false otherwise
	 */
	public kill(): void {
		this.abortControllers.forEach((controller) => controller.abort());
		this.abortControllers.clear();
	}

	/**
	 * Return whether the agent is currently processing a request
	 */
	public get processing(): boolean {
		return this.abortControllers.size > 0;
	}
}
