import {
	AssistantModelMessage,
	CallSettings as AICallSettings,
	LanguageModel,
	ModelMessage,
	streamText,
	ToolSet,
	UserModelMessage
} from "ai";
import {
	MagmaInfo,
	MagmaMessageHandler,
	MagmaMiddlewareSet,
	MagmaStreamChunk,
	MagmaSystemMessage,
	MagmaToolInfo,
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

type CallSettings = Omit<AICallSettings, "abortSignal">;

function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "AbortError"
	);
}

function createAbortError(): Error {
	const error = new Error("Agent request aborted");
	error.name = "AbortError";
	return error;
}

export type MagmaLLMConfig = {
	general?: CallSettings;
	model: LanguageModel;
};

export const DEFAULT_MAX_MIDDLEWARE_RETRIES = 5;

export type MagmaAgentProps<STATE, TOOLS extends MagmaToolSet<STATE>> = {
	state: STATE;
	llmConfig: MagmaLLMConfig;
	getSystemPrompts?: (info: MagmaInfo<STATE, TOOLS>) => MagmaSystemMessage[];
	tools?: TOOLS;
	middleware?: MagmaMiddlewareSet<STATE, TOOLS>;
	onMessage: MagmaMessageHandler<STATE, TOOLS>;
	onStreamChunk?: (chunk: MagmaStreamChunk, info: MagmaInfo<STATE, TOOLS>) => void;
	onTrace?: (trace: TraceEvent[], info: MagmaInfo<STATE, TOOLS>) => void;

	messageContext?: number;
	onUsageUpdate?: (usage: MagmaUsage, info: MagmaInfo<STATE, TOOLS>) => void;
	onError?: (error: Error) => void;

	verbose?: boolean;
};

type RunTicket = {
	content: MagmaUserMessage["content"];
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	settled: boolean;
};

type TurnState<STATE, TOOLS extends MagmaToolSet<STATE>> = {
	ctx: Record<string, unknown>;
	epoch: number;
	historyCheckpoint: number;
	info: MagmaInfo<STATE, TOOLS>;
	middlewareRetries: Record<string, number>;
	requestId: string;
	tickets: RunTicket[];
	trace: TraceEvent[];
	traceEmitted: boolean;
};

export class MagmaAgent<
	STATE = Record<string, unknown>,
	TOOLS extends MagmaToolSet<STATE> = MagmaToolSet<STATE>
> implements MagmaAgentProps<STATE, TOOLS> {
	state: STATE;
	llmConfig: MagmaLLMConfig;
	getSystemPrompts: (info: MagmaInfo<STATE, TOOLS>) => MagmaSystemMessage[] = () => [];
	tools: TOOLS;
	middleware: MagmaMiddlewareSet<STATE, TOOLS>;
	onMessage: MagmaMessageHandler<STATE, TOOLS>;
	onStreamChunk: (chunk: MagmaStreamChunk, info: MagmaInfo<STATE, TOOLS>) => void;
	onTrace: (trace: TraceEvent[], info: MagmaInfo<STATE, TOOLS>) => void;

	messageContext: number;
	onUsageUpdate: (usage: MagmaUsage, info: MagmaInfo<STATE, TOOLS>) => void;
	onError: (error: Error) => void;

	verbose?: boolean;

	messages: ModelMessage[];

	private activeAbortController: AbortController | null = null;
	private activeHistoryCheckpoint: number | null = null;
	private activeTickets: RunTicket[] = [];
	private processingLoop: Promise<void> | null = null;
	private runEpoch = 0;
	private steeringQueue: RunTicket[] = [];

	constructor(
		props: Omit<MagmaAgentProps<STATE, TOOLS>, "tools" | "middleware">,
		tools?: TOOLS,
		middleware?: MagmaMiddlewareSet<STATE, TOOLS>
	) {
		this.state = props.state;
		this.llmConfig = props.llmConfig;

		this.tools = (tools ?? {}) as TOOLS;
		this.middleware = (middleware ?? {}) as MagmaMiddlewareSet<STATE, TOOLS>;
		this.onMessage = props.onMessage ?? (async () => {});
		this.onStreamChunk = props.onStreamChunk ?? (() => {});
		this.onTrace = props.onTrace ?? (() => {});

		this.messageContext = props.messageContext ?? -1;
		this.onUsageUpdate = props.onUsageUpdate ?? (() => {});
		this.getSystemPrompts = props.getSystemPrompts ?? (() => []);
		this.onError =
			props.onError ??
			((error) => {
				console.error(error);
				throw error;
			});

		this.verbose = props.verbose;
		this.messages = [];

		this.log("Agent initialized");
	}

	public log(message: string): void {
		if (this.verbose) {
			console.log(message);
		}
	}

	public run(content: MagmaUserMessage["content"]): Promise<void> {
		let resolvePromise!: () => void;
		let rejectPromise!: (error: unknown) => void;
		const promise = new Promise<void>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		const ticket: RunTicket = {
			content,
			promise,
			resolve: resolvePromise,
			reject: rejectPromise,
			settled: false
		};

		this.steeringQueue.push(ticket);
		this.startProcessing();

		return ticket.promise;
	}

	private startProcessing(): void {
		if (this.processingLoop) return;

		const loop = this.processQueue();
		this.processingLoop = loop;
		void loop.then(
			() => this.finishProcessing(loop),
			(error) => {
				this.log(`Processing loop failed: ${parseErrorToString(error)}`);
				this.finishProcessing(loop);
			}
		);
	}

	private finishProcessing(loop: Promise<void>): void {
		if (this.processingLoop !== loop) return;
		this.processingLoop = null;
		this.activeAbortController = null;
		this.activeHistoryCheckpoint = null;

		if (this.steeringQueue.length > 0) {
			this.startProcessing();
		}
	}

	private async processQueue(): Promise<void> {
		while (this.steeringQueue.length > 0) {
			const ctx: Record<string, unknown> = {};
			const turn: TurnState<STATE, TOOLS> = {
				ctx,
				epoch: this.runEpoch,
				historyCheckpoint: this.messages.length,
				info: {
					agent: this,
					ctx
				},
				middlewareRetries: {},
				requestId: Math.random().toString(36).substring(2, 15),
				tickets: [],
				trace: [],
				traceEmitted: false
			};
			this.activeHistoryCheckpoint = turn.historyCheckpoint;
			this.activeTickets = turn.tickets;

			try {
				await this.incorporateSteering(turn);
				this.ensureActive(turn.epoch);

				if (turn.tickets.length > 0) {
					await this.processTurn(turn);
				} else {
					this.emitTrace(turn);
				}
			} catch (error) {
				this.rollbackHistory(turn);
				if (!isAbortError(error)) {
					let parsedError = parseErrorToError(error);
					try {
						this.emitTrace(turn);
					} catch (traceError) {
						parsedError = parseErrorToError(traceError);
					}
					this.log(`Main loop failed: ${parsedError.message}`);
					try {
						this.onError(parsedError);
					} catch {
						// Ticket rejection is the public error channel.
					}
					this.rejectTickets(turn.tickets, parsedError);
				} else {
					try {
						this.emitTrace(turn);
					} catch {
						// Cancellation has already settled the affected tickets.
					}
				}
			} finally {
				if (this.activeTickets === turn.tickets) {
					this.activeTickets = [];
					this.activeHistoryCheckpoint = null;
				}
				this.activeAbortController = null;
			}

			if (turn.epoch !== this.runEpoch) return;
		}
	}

	private async incorporateSteering(turn: TurnState<STATE, TOOLS>): Promise<void> {
		while (this.steeringQueue.length > 0) {
			const queuedTickets = this.steeringQueue.splice(0);

			for (const ticket of queuedTickets) {
				this.ensureActive(turn.epoch);
				turn.tickets.push(ticket);

				try {
					const message = await runPreCompletionMiddleware({
						info: turn.info,
						middleware: this.middleware,
						message: {
							role: "user",
							content: ticket.content
						} as UserModelMessage,
						trace: turn.trace,
						requestId: turn.requestId
					});
					this.ensureActive(turn.epoch);

					this.messages.push(message);
				} catch (error) {
					if (isAbortError(error) || turn.epoch !== this.runEpoch) {
						throw createAbortError();
					}
					const ticketIndex = turn.tickets.indexOf(ticket);
					if (ticketIndex !== -1) {
						turn.tickets.splice(ticketIndex, 1);
					}
					const errorContent = parseErrorToString(error);
					try {
						await this.onMessage(
							{
								role: "assistant",
								content: errorContent
							},
							turn.info
						);
						this.resolveTicket(ticket);
					} catch (eventError) {
						this.rejectTicket(ticket, eventError);
					}
				}
			}
		}
	}

	private async processTurn(turn: TurnState<STATE, TOOLS>): Promise<void> {
		while (turn.tickets.length > 0) {
			this.ensureActive(turn.epoch);
			const completion = await this.generateCompletion(turn);
			this.ensureActive(turn.epoch);
			this.messages.push(completion);

			let completedMessage: AssistantModelMessage | null;
			try {
				completedMessage = await runOnCompletionMiddleware({
					info: turn.info,
					middleware: this.middleware,
					message: completion,
					trace: turn.trace,
					requestId: turn.requestId,
					middlewareRetries: turn.middlewareRetries
				});
			} catch (error) {
				this.messages.pop();
				this.messages.push({
					role: "system",
					content: parseErrorToString(error)
				});
				continue;
			}
			if (!completedMessage) {
				throw new Error(
					"Catastrophic error: failed critical onCompletion middleware maximum number of times"
				);
			}
			this.messages[this.messages.length - 1] = completedMessage;

			if (this.hasToolCalls(completedMessage)) {
				let toolCallMessage: AssistantModelMessage | null;
				try {
					toolCallMessage = await runPreToolExecutionMiddleware({
						info: turn.info,
						middleware: this.middleware,
						message: completedMessage,
						trace: turn.trace,
						requestId: turn.requestId,
						middlewareRetries: turn.middlewareRetries
					});
				} catch (error) {
					this.messages.pop();
					this.messages.push({
						role: "system",
						content: parseErrorToString(error)
					});
					continue;
				}
				if (!toolCallMessage) {
					throw new Error(
						"Catastrophic error: failed critical preToolExecution middleware maximum number of times"
					);
				}
				this.messages[this.messages.length - 1] = toolCallMessage;

				await this.onMessage(toolCallMessage, turn.info);
				this.ensureActive(turn.epoch);

				const toolResult = await executeTools({
					info: turn.info,
					state: this.state,
					message: toolCallMessage,
					trace: turn.trace,
					requestId: turn.requestId
				});
				this.ensureActive(turn.epoch);

				const processedToolResult = await runOnToolExecutionMiddleware({
					info: turn.info,
					middleware: this.middleware,
					message: toolResult,
					trace: turn.trace,
					requestId: turn.requestId
				});
				this.ensureActive(turn.epoch);
				this.messages.push(processedToolResult);
				await this.onMessage(processedToolResult, turn.info);
				this.ensureActive(turn.epoch);
				this.commitHistory(turn);

				await this.incorporateSteering(turn);
				continue;
			}

			await this.onMessage(completedMessage, turn.info);
			this.ensureActive(turn.epoch);
			this.emitTrace(turn);
			this.commitHistory(turn);
			this.resolveTickets(turn.tickets);
			turn.tickets.length = 0;
		}
	}

	private async generateCompletion(
		turn: TurnState<STATE, TOOLS>
	): Promise<AssistantModelMessage> {
		const completionMessages =
			this.messageContext === -1 ? this.messages : this.messages.slice(-this.messageContext);
		const enabledTools = Object.entries(this.tools)
			.filter(([_, tool]) => {
				const enabled =
					"enabled" in tool
						? (tool.enabled as
								| ((info: MagmaToolInfo<STATE, TOOLS>) => boolean)
								| undefined)
						: undefined;
				return enabled ? enabled(turn.info) : true;
			})
			.map(([name, tool]) => [name, { ...tool, execute: undefined, enabled: undefined }]);
		const tools = Object.fromEntries(enabledTools) as ToolSet;
		const abortController = new AbortController();
		this.activeAbortController = abortController;

		try {
			const { fullStream, content, totalUsage } = streamText({
				model: this.llmConfig.model,
				tools,
				system: this.getSystemPrompts(turn.info),
				messages: completionMessages,
				...this.llmConfig.general,
				abortSignal: abortController.signal
			});
			const contentPromise = Promise.resolve(content);
			const usagePromise = Promise.resolve(totalUsage);

			// The stream can fail before these AI SDK promises are awaited. Attach handlers
			// immediately so an abort does not produce additional unhandled rejections.
			void contentPromise.catch(() => {});
			void usagePromise.catch(() => {});

			for await (const chunk of fullStream) {
				this.ensureActive(turn.epoch);
				this.onStreamChunk(chunk as MagmaStreamChunk, turn.info);
			}

			this.ensureActive(turn.epoch);
			const completionContent = await contentPromise;
			this.ensureActive(turn.epoch);
			const usage = await usagePromise;
			this.onUsageUpdate(usage, turn.info);

			return {
				role: "assistant",
				content: completionContent
			} as AssistantModelMessage;
		} catch (error) {
			if (
				isAbortError(error) ||
				abortController.signal.aborted ||
				turn.epoch !== this.runEpoch
			) {
				throw createAbortError();
			}
			throw error;
		} finally {
			if (this.activeAbortController === abortController) {
				this.activeAbortController = null;
			}
		}
	}

	private hasToolCalls(message: AssistantModelMessage): boolean {
		if (typeof message.content === "string") return false;
		const hasToolCall = message.content.some((part) => part.type === "tool-call");
		const hasToolResult = message.content.some((part) => part.type === "tool-result");
		return hasToolCall && !hasToolResult;
	}

	private ensureActive(epoch: number): void {
		if (epoch !== this.runEpoch) {
			throw createAbortError();
		}
	}

	private resolveTickets(tickets: RunTicket[]): void {
		for (const ticket of [...tickets]) {
			this.resolveTicket(ticket);
		}
	}

	private resolveTicket(ticket: RunTicket): void {
		if (ticket.settled) return;
		ticket.settled = true;
		ticket.resolve();
	}

	private rejectTickets(tickets: RunTicket[], error: unknown): void {
		for (const ticket of [...tickets]) {
			this.rejectTicket(ticket, error);
		}
		tickets.length = 0;
	}

	private rejectTicket(ticket: RunTicket, error: unknown): void {
		if (ticket.settled) return;
		ticket.settled = true;
		ticket.reject(error);
	}

	private emitTrace(turn: TurnState<STATE, TOOLS>): void {
		if (turn.traceEmitted) return;
		turn.traceEmitted = true;
		this.onTrace([...turn.trace], turn.info);
	}

	private commitHistory(turn: TurnState<STATE, TOOLS>): void {
		turn.historyCheckpoint = this.messages.length;
		this.activeHistoryCheckpoint = turn.historyCheckpoint;
	}

	private rollbackHistory(turn: TurnState<STATE, TOOLS>): void {
		this.messages.splice(turn.historyCheckpoint);
	}

	/**
	 * Stops the current turn and rejects all active and queued calls.
	 */
	public kill(): void {
		this.runEpoch++;
		this.activeAbortController?.abort();
		this.activeAbortController = null;
		if (this.activeHistoryCheckpoint !== null) {
			this.messages.splice(this.activeHistoryCheckpoint);
		}

		const abortError = createAbortError();
		this.rejectTickets(this.activeTickets, abortError);
		const queuedTickets = this.steeringQueue.splice(0);
		this.rejectTickets(queuedTickets, abortError);
	}

	/**
	 * Return whether the agent is currently processing a request.
	 */
	public get processing(): boolean {
		return (
			this.steeringQueue.some((ticket) => !ticket.settled) ||
			this.activeTickets.some((ticket) => !ticket.settled)
		);
	}
}
