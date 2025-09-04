import {
    MagmaMiddleware,
    MagmaUtilities,
    MagmaHook,
    MagmaJob,
    TraceEvent,
    MagmaSendFunction,
    MagmaReceiver,
    MagmaStreamChunk,
    MagmaTool,
    MagmaToolResult,
    MagmaToolCall,
    MagmaUsage,
    MagmaUserMessage,
    MagmaAssistantMessage,
    MagmaSystemMessage,
    MagmaToolResultMessage,
    MagmaMessage,
} from './types';
import {
    loadHooks,
    loadJobs,
    loadMiddleware,
    loadReceivers,
    loadTools,
    parseErrorToError,
    parseErrorToString,
} from './helpers/index';
import cron from 'node-cron';
import {
    createOpenRouter,
    OpenRouterProvider,
    OpenRouterProviderOptions,
} from '@openrouter/ai-sdk-provider';
import {
    CallSettings,
    FilePart,
    ImagePart,
    streamText,
    TextPart,
    ToolCallPart,
    ToolChoice,
    ToolResultPart,
    ToolSet,
} from 'ai';
import { convertMagmaToolToAISDKTool } from './helpers/conversions';
import {
    AssistantModelMessage,
    ModelMessage,
    ReasoningPart,
    ToolModelMessage,
    UserModelMessage,
} from '@ai-sdk/provider-utils';

const kMiddlewareMaxRetries = 5;

type AgentProps = {
    openrouter?: OpenRouterProviderOptions;
    general?: CallSettings;
    verbose?: boolean;
    messageContext?: number;
    stream?: boolean;
    sessionId?: string;
};

export class MagmaAgent {
    verbose?: boolean;
    stream: boolean = false;
    public sessionId: string;

    private provider: OpenRouterProvider = createOpenRouter();
    public config: { openrouter?: OpenRouterProviderOptions; general?: CallSettings } = {
        openrouter: {
            models: ['openai/gpt-4o'],
        },
        general: {},
    };
    public messages: Array<MagmaMessage>;
    private middlewareRetries: Record<string, number>;
    private messageContext: number;
    private scheduledJobs: cron.ScheduledTask[];
    private abortControllers: Map<string, AbortController> = new Map();

    constructor(args?: AgentProps) {
        this.messageContext = args?.messageContext ?? 20;
        this.verbose = args?.verbose ?? false;
        this.stream = args?.stream ?? false;
        this.sessionId = args?.sessionId ?? '';

        args ??= {
            openrouter: {
                models: ['openai/gpt-4o'],
            },
        };

        this.config = {
            openrouter: {
                ...args.openrouter,
            },
            general: {
                ...args.general,
            },
        };

        this.messages = [];
        this.middlewareRetries = {};

        this.scheduledJobs = [];

        this.log('Agent initialized');
    }

    public log(message: string): void {
        if (this.verbose) {
            console.log(message);
        }
    }

    public async setup?(opts?: object): Promise<void> {}

    public async onWsClose(code: number, reason?: string): Promise<void> {}

    public async cleanup(): Promise<void> {
        try {
            await this.onCleanup();
        } catch (error) {
            this.log(`Error during cleanup: ${parseErrorToString(error)}`);
        } finally {
            this._cleanup();
        }
    }

    private async _cleanup(): Promise<void> {
        this.abortControllers.forEach((controller) => controller.abort());
        this.abortControllers.clear();

        this.log('Agent cleanup complete');
    }

    public async main(args: {
        config?: {
            openrouter?: OpenRouterProviderOptions;
            general?: CallSettings & { toolChoice?: ToolChoice<ToolSet> };
        };
        send?: MagmaSendFunction;
        userMessage: MagmaUserMessage;
        onTrace?: (trace: TraceEvent[]) => void;
        trigger?: false;
    }): Promise<MagmaAssistantMessage | null>;

    public async main(args: {
        config?: {
            openrouter?: OpenRouterProviderOptions;
            general?: CallSettings & { toolChoice?: ToolChoice<ToolSet> };
        };
        send?: MagmaSendFunction;
        userMessage: MagmaUserMessage;
        onTrace?: (trace: TraceEvent[]) => void;
        trigger: true;
    }): Promise<MagmaToolResultMessage | null>;

    public async main(args: {
        config?: {
            openrouter?: OpenRouterProviderOptions;
            general?: CallSettings & { toolChoice?: ToolChoice<ToolSet> };
        };
        send?: MagmaSendFunction;
        userMessage: MagmaUserMessage;
        onTrace?: (trace: TraceEvent[]) => void;
        trigger?: boolean;
    }): Promise<MagmaAssistantMessage | MagmaToolResultMessage | null> {
        return (await this._main({
            config: args.config,
            send: args.send,
            userOrToolMessage: args.userMessage,
            onTrace: args.onTrace,
            trigger: args.trigger,
        })) as MagmaToolResultMessage | null;
    }

    private async _main(args: {
        config?: {
            openrouter?: OpenRouterProviderOptions;
            general?: CallSettings & { toolChoice?: ToolChoice<ToolSet> };
        };
        send?: MagmaSendFunction;
        userOrToolMessage: UserModelMessage | ToolModelMessage;
        trigger?: boolean;
        originIndex?: number;
        messages?: Array<ModelMessage>;
        trace?: TraceEvent[];
        onTrace?: (trace: TraceEvent[]) => void;
    }): Promise<AssistantModelMessage | MagmaToolResultMessage | null> {
        const {
            config,
            trace = [],
            onTrace,
            send = () => {},
            userOrToolMessage,
            trigger = false,
        } = args;
        let originIndex = args.originIndex;
        const localMessages = [
            ...(args?.messages ?? this.messages.filter((m) => m.role !== 'system')),
        ];

        const requestId = Math.random().toString(36).substring(2, 15);
        try {
            // this promise will resolve when either main finishes or the abort controller is aborted
            const mainPromise = new Promise<AssistantModelMessage | MagmaToolResultMessage | null>(
                async (resolve, reject) => {
                    try {
                        const abortController = new AbortController();
                        this.abortControllers.set(requestId, abortController);
                        abortController.signal.onabort = () => {
                            this.abortControllers.delete(requestId);
                            return resolve(null);
                        };

                        // Save the index of the newest user message
                        let userOrToolMessageIndex: number = localMessages.length;
                        if (originIndex === undefined) originIndex = userOrToolMessageIndex;
                        localMessages.push(userOrToolMessage);

                        // Run the preCompletion middleware
                        let preCompletionMiddlewareResult: UserModelMessage | ToolModelMessage;

                        if (userOrToolMessage.role === 'user') {
                            // user message, so we run preCompletion middleware
                            try {
                                preCompletionMiddlewareResult =
                                    await this.runPreCompletionMiddleware({
                                        message: userOrToolMessage as UserModelMessage,
                                        trace,
                                        requestId,
                                        send,
                                    });
                            } catch (error) {
                                // If the preCompletion middleware fails, we should remove the last message
                                localMessages.pop();

                                // Return the error message as a tool result if we are in trigger mode
                                if (trigger) {
                                    return resolve({
                                        role: 'tool',
                                        content: [
                                            {
                                                type: 'tool-result',
                                                toolCallId: 'N/A',
                                                toolName: 'N/A',
                                                output: {
                                                    type: 'error-text',
                                                    value: parseErrorToString(error),
                                                },
                                            },
                                        ],
                                    });
                                }

                                // Return the error message as the assistant message if we are not in trigger mode
                                return resolve({
                                    role: 'assistant',
                                    content: parseErrorToString(error),
                                });
                            }
                        } else {
                            // tool result message, so we don't need to run preCompletion middleware
                            preCompletionMiddlewareResult = userOrToolMessage as ToolModelMessage;
                        }

                        // Update the last user message with the result of the preCompletion middleware
                        localMessages[userOrToolMessageIndex] = preCompletionMiddlewareResult;

                        // Determine the config to be used for this request
                        const configToUse = config ?? this.config;

                        configToUse.openrouter ??= {
                            models: this.config.openrouter?.models,
                        };

                        // If we don't have a model defined, use the models defined in the state config
                        if (
                            !configToUse.openrouter?.models ||
                            configToUse.openrouter.models.length === 0
                        ) {
                            this.log(
                                'No models supplied to main call config, defaulting to existing models'
                            );
                            configToUse.openrouter.models = this.config.openrouter?.models ?? [
                                'openai/gpt-4o',
                            ];
                        }

                        // based on the slice, these are the message we should use for the completion
                        const completionMessages =
                            this.messageContext === -1
                                ? localMessages
                                : localMessages.slice(-this.messageContext);

                        // get the completion
                        // we will always use a stream, and only use the onStreamChunk callback if stream mode is active
                        const { fullStream, content, totalUsage } = streamText({
                            model: this.provider(configToUse.openrouter.models![0], {
                                ...configToUse.openrouter,
                                usage: { include: true },
                            }),
                            tools: Object.fromEntries(
                                this.tools
                                    .filter((t) => t.enabled(this))
                                    .map((t) => [t.name, convertMagmaToolToAISDKTool(t)])
                            ),
                            messages: [...this.getSystemPrompts(), ...completionMessages],
                            abortSignal: this.abortControllers.get(requestId)?.signal,
                            ...configToUse.general,
                        });

                        // Ensure the abort controller is still active
                        if (!this.abortControllers.has(requestId)) {
                            return resolve(null);
                        }

                        for await (const chunk of fullStream) {
                            if (this.stream) {
                                this.onStreamChunk(chunk, send);
                            }
                        }

                        // create the Asisstant message from the completion
                        const completion = {
                            role: 'assistant',
                            content: await content,
                        } as AssistantModelMessage;

                        // Call the onUsageUpdate callback
                        this.onUsageUpdate(await totalUsage);

                        // Add the completion message to the messages array
                        localMessages.push({
                            role: 'assistant',
                            content: await content,
                        } as AssistantModelMessage);

                        // Run the onCompletion middleware
                        // this will only affect text content from the assistant
                        let onCompletionMiddlewareResult: AssistantModelMessage | null;
                        try {
                            onCompletionMiddlewareResult = await this.runOnCompletionMiddleware({
                                message: completion,
                                trace,
                                requestId,
                                send,
                            });
                        } catch (error) {
                            // If the onCompletion middleware fails, we should remove the last message
                            // This is the failing assistant message
                            localMessages.pop();

                            // We should also remove the user message, as it will be re-added in the subsequent main call
                            localMessages.pop();

                            // Add the error message to the messages array
                            localMessages.push({
                                role: 'system',
                                content: parseErrorToString(error),
                            });

                            // Trigger another completion with the error message as context
                            return resolve(
                                await this._main({
                                    config: configToUse,
                                    send,
                                    messages: localMessages,
                                    userOrToolMessage,
                                    trigger,
                                    originIndex,
                                    trace,
                                    onTrace,
                                })
                            );
                        }

                        // If the onCompletion middleware returns null
                        // That means it failed to meet the middleware requirements in ${kMiddlewareMaxRetries} attempts
                        if (!onCompletionMiddlewareResult) {
                            throw new Error(
                                `Catastrophic error: failed onCompletion middleware ${kMiddlewareMaxRetries} times`
                            );
                        }

                        // Update the last message with the result of the onCompletion middleware
                        localMessages[localMessages.length - 1] = onCompletionMiddlewareResult;

                        // If the onCompletion middleware returns a tool call, we should execute the tools

                        let onToolExecutionMiddlewareResult: ToolModelMessage | null;
                        if (
                            typeof onCompletionMiddlewareResult.content !== 'string' &&
                            onCompletionMiddlewareResult.content.filter(
                                (c) => c.type === 'tool-call'
                            ).length > 0
                        ) {
                            let preToolExecutionMiddlewareResult: AssistantModelMessage | null;
                            try {
                                preToolExecutionMiddlewareResult =
                                    await this.runPreToolExecutionMiddleware({
                                        message: onCompletionMiddlewareResult,
                                        trace,
                                        requestId,
                                        send,
                                    });
                            } catch (error) {
                                // Remove the failing tool call message
                                localMessages.pop();

                                // Remove the user message, as it will be readded in the subsequent main call
                                localMessages.pop();

                                localMessages.push({
                                    role: 'system',
                                    content: parseErrorToString(error),
                                });

                                return resolve(
                                    await this._main({
                                        config: configToUse,
                                        send,
                                        messages: localMessages,
                                        userOrToolMessage,
                                        trigger,
                                        originIndex,
                                        trace,
                                        onTrace,
                                    })
                                );
                            }

                            if (!preToolExecutionMiddlewareResult) {
                                throw new Error(
                                    `Catastrophic error: failed preToolExecution middleware ${kMiddlewareMaxRetries} times`
                                );
                            }

                            // Update the last message with the result of the onCompletion middleware
                            localMessages[localMessages.length - 1] =
                                preToolExecutionMiddlewareResult;

                            // Execute the tools
                            const toolResultMessage = await this.executeTools({
                                message: preToolExecutionMiddlewareResult,
                                trace,
                                requestId,
                                send,
                            });

                            onToolExecutionMiddlewareResult =
                                await this.runOnToolExecutionMiddleware({
                                    message: toolResultMessage,
                                    trace,
                                    requestId,
                                    send,
                                });

                            // If the abort controller is not active, return null
                            if (!this.abortControllers.has(requestId)) {
                                return resolve(null);
                            }

                            // if we are in trigger mode, the tool call is our result
                            if (trigger) {
                                return resolve(onToolExecutionMiddlewareResult);
                            }

                            // Trigger another completion with the tool result because last message was a tool call and we are not in trigger mode
                            return resolve(
                                await this._main({
                                    config: configToUse,
                                    send,
                                    messages: localMessages,
                                    userOrToolMessage: onToolExecutionMiddlewareResult,
                                    trigger,
                                    originIndex,
                                    trace,
                                    onTrace,
                                })
                            );
                        }

                        // If the onCompletion middleware does not return a tool call, we should run the onMainFinish middleware
                        let onMainFinishMiddlewareResult: AssistantModelMessage | null;
                        try {
                            onMainFinishMiddlewareResult = await this.runOnMainFinishMiddleware({
                                message: onCompletionMiddlewareResult,
                                trace,
                                requestId,
                                send,
                            });
                        } catch (error) {
                            // If the onMainFinish middleware fails, we should remove the offending message
                            localMessages.pop();

                            // Also remove the message before as it will be re-added in the subsequent main call
                            localMessages.pop();

                            // Add the error message to the messages array
                            localMessages.push({
                                role: 'system',
                                content: parseErrorToString(error),
                            });

                            return resolve(
                                await this._main({
                                    config: configToUse,
                                    send,
                                    messages: localMessages,
                                    userOrToolMessage,
                                    trigger,
                                    originIndex,
                                    trace,
                                    onTrace,
                                })
                            );
                        }

                        if (!onMainFinishMiddlewareResult) {
                            throw new Error(
                                `Catastrophic error: failed onMainFinish middleware ${kMiddlewareMaxRetries} times`
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

    public scheduleJobs({ verbose = false }: { verbose?: boolean } = {}): void {
        const jobs = this.jobs;

        for (const job of jobs) {
            if (verbose)
                this.log(`Job ${job.handler.name.split(' ').at(-1)} scheduled for ${job.schedule}`);
            this.scheduledJobs.push(
                cron.schedule(job.schedule, () => job.handler.call(this, this), job.options)
            );
        }
    }

    public cancelJobs(): void {
        for (const scheduledJob of this.scheduledJobs) {
            scheduledJob.stop();
        }

        this.scheduledJobs = [];
    }

    /**
     * Given a tool call, find the appropriate function to handle the run
     *
     * @param message MagmaAssistantMessage message to execute tools on
     * @param allowList optional, list of tool names to allow
     * @param trace trace event array
     * @param requestId request id
     * @returns MagmaUserMessage with tool results
     */
    private async executeTools({
        message,
        allowList = [],
        trace,
        requestId,
        send,
    }: {
        message: AssistantModelMessage;
        allowList?: string[];
        trace: TraceEvent[];
        requestId: string;
        send: MagmaSendFunction;
    }): Promise<ToolModelMessage> {
        try {
            let toolResultMessage: ToolModelMessage = {
                role: 'tool',
                content: [],
            };

            // execute the tool calls
            for (const contentPart of message.content) {
                if (typeof contentPart === 'string') continue;
                if (contentPart.type !== 'tool-call') continue;

                const toolCall = contentPart;

                let toolResult: ToolResultPart;

                try {
                    const tool = this.tools
                        .filter((t) => t.enabled(this) || allowList.includes(t.name))
                        .find((t) => t.name === toolCall.toolName);
                    if (!tool)
                        throw new Error(`No tool found to handle call for ${toolCall.toolName}()`);

                    // Trace individual tool call execution
                    trace.push({
                        type: 'tool_execution',
                        phase: 'start',
                        requestId,
                        timestamp: Date.now(),
                        data: {
                            toolCall,
                            toolName: tool.name,
                        },
                    });

                    let result = await tool.target(toolCall, send, this);

                    if (!result) {
                        this.log(`No result returned for ${toolCall.toolName}()`);
                        result = {
                            type: 'text',
                            value: 'No result returned',
                        };
                    }

                    if (typeof result === 'string') {
                        result = {
                            type: 'text',
                            value: result,
                        };
                    } else if (typeof result === 'object') {
                        const typeOptions: ToolResultPart['output']['type'][] = [
                            'text',
                            'content',
                            'json',
                            'error-text',
                            'error-json',
                        ];
                        if (!('type' in result) || !typeOptions.includes(result['type'])) {
                            result = {
                                type: 'json',
                                value: result,
                            };
                        }
                    }

                    toolResult = {
                        type: 'tool-result',
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        providerOptions: toolCall.providerOptions,
                        output: result as ToolResultPart['output'],
                    };

                    trace.push({
                        type: 'tool_execution',
                        phase: 'end',
                        status: 'success',
                        requestId,
                        timestamp: Date.now(),
                        data: {
                            toolCall,
                            toolName: tool.name,
                            result: toolResult,
                        },
                    });
                } catch (error) {
                    const errorString = parseErrorToString(error);
                    const errorMessage = `Tool Execution Failed for ${toolCall.toolName}() - ${errorString}`;
                    this.log(errorMessage);

                    trace.push({
                        type: 'tool_execution',
                        phase: 'end',
                        status: 'error',
                        requestId,
                        timestamp: Date.now(),
                        data: {
                            toolCall,
                            toolName: toolCall.toolName,
                            error: errorString,
                        },
                    });

                    toolResult = {
                        type: 'tool-result',
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        providerOptions: toolCall.providerOptions,
                        output: { type: 'error-text', value: errorString },
                    };
                }

                toolResultMessage.content.push(toolResult);
            }

            return toolResultMessage;
        } catch (error) {
            throw error;
        }
    }

    private async runPreCompletionMiddleware({
        message,
        trace,
        requestId,
        send,
    }: {
        message: UserModelMessage;
        trace: TraceEvent[];
        requestId: string;
        send: MagmaSendFunction;
    }): Promise<UserModelMessage> {
        // get preCompletion middleware
        const preCompletionMiddleware = this.middleware.filter(
            (f) => f.trigger === 'preCompletion'
        );
        if (preCompletionMiddleware.length === 0) return message;

        const contentToRun =
            typeof message.content === 'string'
                ? [{ type: 'text', text: message.content } as TextPart]
                : message.content;

        // initialize result content
        const resultContent: Array<TextPart | ImagePart | FilePart> = [];

        try {
            // go through the blocks of the incoming message
            for (let i = 0; i < contentToRun.length; i++) {
                // add the block to the result message
                resultContent.push(contentToRun[i]);
                // if the block is a text block, we should run each middleware on it
                if (contentToRun[i].type === 'text') {
                    const textBlock = contentToRun[i] as TextPart;
                    for (const mdlwr of preCompletionMiddleware) {
                        try {
                            trace.push({
                                type: 'middleware',
                                phase: 'start',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    input: textBlock.text,
                                },
                            });
                            // run the middleware on the text block
                            const middlewareResult = (await mdlwr.action(
                                textBlock.text,
                                send,
                                this
                            )) as string;
                            // if the middleware has a return value, we should update the text block in the result message
                            if (middlewareResult !== undefined) {
                                this.log(
                                    `${mdlwr.name} middleware modified text block` +
                                        '\n' +
                                        `Original: ${textBlock.text}` +
                                        '\n' +
                                        `Modified: ${middlewareResult}`
                                );
                                textBlock.text = middlewareResult;
                            }

                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'success',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    output: middlewareResult,
                                },
                            });
                        } catch (error) {
                            let errorMessage = parseErrorToString(error);
                            this.log(
                                `Error in preCompletion middleware (${mdlwr.name}): ${errorMessage}`
                            );

                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'error',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    error: errorMessage,
                                },
                            });
                            throw new Error(errorMessage);
                        }
                    }
                }
            }
        } catch (error) {
            throw error;
        }

        // return the result message
        return {
            role: 'user',
            content: resultContent,
        };
    }

    private async runOnCompletionMiddleware({
        message,
        trace,
        requestId,
        send,
    }: {
        message: AssistantModelMessage;
        trace: TraceEvent[];
        requestId: string;
        send: MagmaSendFunction;
    }): Promise<AssistantModelMessage | null> {
        // get onCompletion middleware
        const onCompletionMiddleware = this.middleware.filter((f) => f.trigger === 'onCompletion');
        if (onCompletionMiddleware.length === 0) return message;

        const contentToRun =
            typeof message.content === 'string'
                ? [{ type: 'text', text: message.content } as TextPart]
                : message.content;

        // initialize result content
        const resultContent: Array<
            TextPart | FilePart | ReasoningPart | ToolCallPart | ToolResultPart
        > = [];

        try {
            // go through the blocks of the incoming message
            for (let i = 0; i < contentToRun.length; i++) {
                // add the block to the result message
                resultContent.push(contentToRun[i]);
                // if the block is a text block, we should run each middleware on it
                if (contentToRun[i].type === 'text') {
                    const textBlock = contentToRun[i] as TextPart;
                    for (const mdlwr of onCompletionMiddleware) {
                        try {
                            trace.push({
                                type: 'middleware',
                                phase: 'start',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    input: textBlock.text,
                                },
                            });
                            // run the middleware on the text block
                            const middlewareResult = (await mdlwr.action(
                                textBlock.text,
                                send,
                                this
                            )) as string;
                            // if the middleware has a return value, we should update the text block in the result message
                            if (middlewareResult !== undefined) {
                                this.log(
                                    `${mdlwr.name} middleware modified text block` +
                                        '\n' +
                                        `Original: ${textBlock.text}` +
                                        '\n' +
                                        `Modified: ${middlewareResult}`
                                );
                                textBlock.text = middlewareResult;
                            }

                            delete this.middlewareRetries[mdlwr.id];

                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'success',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    output: middlewareResult,
                                },
                            });
                        } catch (error) {
                            let errorMessage = parseErrorToString(error);
                            this.log(
                                `Error in onCompletion middleware (${mdlwr.name}): ${errorMessage}`
                            );

                            this.middlewareRetries[mdlwr.id] =
                                (this.middlewareRetries[mdlwr.id] ?? 0) + 1;

                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'error',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    error: errorMessage,
                                },
                            });
                            if (this.middlewareRetries[mdlwr.id] >= kMiddlewareMaxRetries) {
                                if (mdlwr.critical) {
                                    this.log(
                                        `Middleware ${mdlwr.name} failed, and is critical. Returning null...`
                                    );
                                    return null;
                                } else {
                                    this.log(
                                        `Middleware ${mdlwr.name} failed, but is not critical. Continuing...`
                                    );
                                    continue;
                                }
                            }
                            throw new Error(errorMessage);
                        }
                    }
                }
            }
        } catch (error) {
            throw error;
        }

        // return the result message
        return {
            role: 'assistant',
            content: resultContent,
        };
    }

    private async runOnMainFinishMiddleware({
        message,
        trace,
        requestId,
        send,
    }: {
        message: AssistantModelMessage;
        trace: TraceEvent[];
        requestId: string;
        send: MagmaSendFunction;
    }): Promise<AssistantModelMessage | null> {
        // get onMainFinish middleware
        const onMainFinishMiddleware = this.middleware.filter((f) => f.trigger === 'onMainFinish');
        if (onMainFinishMiddleware.length === 0) return message;

        const contentToRun =
            typeof message.content === 'string'
                ? [{ type: 'text', text: message.content } as TextPart]
                : message.content;

        // initialize result content
        const resultContent: Array<
            TextPart | FilePart | ReasoningPart | ToolCallPart | ToolResultPart
        > = [];

        try {
            // go through the blocks of the incoming message
            for (let i = 0; i < contentToRun.length; i++) {
                // add the block to the result message
                resultContent.push(contentToRun[i]);
                // if the block is a text block, we should run each middleware on it
                if (contentToRun[i].type === 'text') {
                    const textBlock = contentToRun[i] as TextPart;
                    for (const mdlwr of onMainFinishMiddleware) {
                        try {
                            trace.push({
                                type: 'middleware',
                                phase: 'start',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    input: textBlock.text,
                                },
                            });
                            // run the middleware on the text block
                            const middlewareResult = (await mdlwr.action(
                                textBlock.text,
                                send,
                                this
                            )) as string;
                            // if the middleware has a return value, we should update the text block in the result message
                            if (middlewareResult !== undefined) {
                                this.log(
                                    `${mdlwr.name} middleware modified text block` +
                                        '\n' +
                                        `Original: ${textBlock.text}` +
                                        '\n' +
                                        `Modified: ${middlewareResult}`
                                );
                                textBlock.text = middlewareResult;
                            }

                            delete this.middlewareRetries[mdlwr.id];

                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'success',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    output: middlewareResult,
                                },
                            });
                        } catch (error) {
                            let errorMessage = parseErrorToString(error);
                            this.log(
                                `Error in onMainFinish middleware (${mdlwr.name}): ${errorMessage}`
                            );

                            this.middlewareRetries[mdlwr.id] =
                                (this.middlewareRetries[mdlwr.id] ?? 0) + 1;

                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'error',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    error: errorMessage,
                                },
                            });
                            if (this.middlewareRetries[mdlwr.id] >= kMiddlewareMaxRetries) {
                                if (mdlwr.critical) {
                                    this.log(
                                        `Middleware ${mdlwr.name} failed, and is critical. Returning null...`
                                    );
                                    return null;
                                } else {
                                    this.log(
                                        `Middleware ${mdlwr.name} failed, but is not critical. Continuing...`
                                    );
                                    continue;
                                }
                            }
                            throw new Error(errorMessage);
                        }
                    }
                }
            }
        } catch (error) {
            throw error;
        }

        // return the result message
        return {
            role: 'assistant',
            content: resultContent,
        };
    }

    private async runPreToolExecutionMiddleware({
        message,
        trace,
        requestId,
        send,
    }: {
        message: AssistantModelMessage;
        trace: TraceEvent[];
        requestId: string;
        send: MagmaSendFunction;
    }): Promise<AssistantModelMessage | null> {
        // get preToolExecution middleware
        const preToolExecutionMiddleware = this.middleware.filter(
            (f) => f.trigger === 'preToolExecution'
        );
        if (preToolExecutionMiddleware.length === 0) return message;
        if (typeof message.content === 'string') return message;

        const contentToRun = message.content;

        // initialize result content
        const resultContent: Array<
            TextPart | FilePart | ReasoningPart | ToolCallPart | ToolResultPart
        > = [];

        try {
            // go through the blocks of the incoming message
            for (let i = 0; i < contentToRun.length; i++) {
                // add the block to the result message
                resultContent.push(contentToRun[i]);
                // if the block is a tool call, we should run each middleware on it
                if (resultContent[i].type === 'tool-call') {
                    const toolCall = resultContent[i] as ToolCallPart;
                    for (const mdlwr of preToolExecutionMiddleware) {
                        try {
                            trace.push({
                                type: 'middleware',
                                phase: 'start',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    input: toolCall.input,
                                },
                            });
                            // run the middleware on the tool call
                            const middlewareResult = (await mdlwr.action(
                                toolCall,
                                send,
                                this
                            )) as MagmaToolCall;
                            // if the middleware has a return value, we should update the tool call in the result message
                            if (middlewareResult !== undefined) {
                                this.log(
                                    `${mdlwr.name} middleware modified tool call block` +
                                        '\n' +
                                        `Original: ${JSON.stringify(toolCall, null, 2)}` +
                                        '\n' +
                                        `Modified: ${JSON.stringify(middlewareResult, null, 2)}`
                                );
                                resultContent[i] = middlewareResult;
                            }

                            delete this.middlewareRetries[mdlwr.id];

                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'success',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    output: middlewareResult,
                                },
                            });
                        } catch (error) {
                            let errorMessage = parseErrorToString(error);
                            this.log(
                                `Error in preToolExecution middleware (${mdlwr.name}): ${errorMessage}`
                            );

                            this.middlewareRetries[mdlwr.id] =
                                (this.middlewareRetries[mdlwr.id] ?? 0) + 1;

                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'error',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    error: errorMessage,
                                },
                            });
                            if (this.middlewareRetries[mdlwr.id] >= kMiddlewareMaxRetries) {
                                if (mdlwr.critical) {
                                    this.log(
                                        `Middleware ${mdlwr.name} failed, and is critical. Returning null...`
                                    );
                                    return null;
                                } else {
                                    this.log(
                                        `Middleware ${mdlwr.name} failed, but is not critical. Continuing...`
                                    );
                                    continue;
                                }
                            }
                            throw new Error(errorMessage);
                        }
                    }
                }
            }
        } catch (error) {
            throw error;
        }

        // return the result message
        return {
            role: 'assistant',
            content: resultContent,
        };
    }

    private async runOnToolExecutionMiddleware({
        message,
        trace,
        requestId,
        send,
    }: {
        message: ToolModelMessage;
        trace: TraceEvent[];
        requestId: string;
        send: MagmaSendFunction;
    }): Promise<ToolModelMessage> {
        // get onToolExecution middleware
        const onToolExecutionMiddleware = this.middleware.filter(
            (f) => f.trigger === 'onToolExecution'
        );
        if (onToolExecutionMiddleware.length === 0) return message;

        const contentToRun = message.content;

        // initialize result content
        const resultContent: Array<ToolResultPart> = [];

        // go through the blocks of the incoming message
        for (let i = 0; i < contentToRun.length; i++) {
            // add the block to the result message
            resultContent.push(contentToRun[i]);
            // if the block is a tool result, we should run each middleware on it
            if (resultContent[i].type === 'tool-result') {
                const toolResult = resultContent[i] as ToolResultPart;
                for (const mdlwr of onToolExecutionMiddleware) {
                    try {
                        trace.push({
                            type: 'middleware',
                            phase: 'start',
                            requestId,
                            timestamp: Date.now(),
                            data: {
                                middleware: mdlwr.name,
                                input: toolResult.output,
                            },
                        });
                        // run the middleware on the tool result
                        const middlewareResult = (await mdlwr.action(
                            toolResult,
                            send,
                            this
                        )) as MagmaToolResult;
                        // if the middleware has a return value, we should update the tool result in the result message
                        if (middlewareResult !== undefined) {
                            resultContent[i] = middlewareResult;
                            this.log(
                                `${mdlwr.name} middleware modified tool result block` +
                                    '\n' +
                                    `Original: ${JSON.stringify(toolResult, null, 2)}` +
                                    '\n' +
                                    `Modified: ${JSON.stringify(middlewareResult, null, 2)}`
                            );
                        }

                        trace.push({
                            type: 'middleware',
                            phase: 'end',
                            status: 'success',
                            requestId,
                            timestamp: Date.now(),
                            data: {
                                middleware: mdlwr.name,
                                output: middlewareResult,
                            },
                        });
                    } catch (error) {
                        let errorString = parseErrorToString(error);

                        trace.push({
                            type: 'middleware',
                            phase: 'end',
                            status: 'error',
                            requestId,
                            timestamp: Date.now(),
                            data: {
                                middleware: mdlwr.name,
                                toolName: toolResult.toolName,
                                result: toolResult,
                                error: errorString,
                            },
                        });

                        this.log(
                            `Error in onToolExecution middleware (${mdlwr.name}): ${errorString}`
                        );

                        toolResult.output = { type: 'error-text', value: errorString };
                    }
                }
            }
        }

        // return the result message
        return {
            role: 'tool',
            content: resultContent,
        };
    }

    /* GETTERS */

    public get utilities(): MagmaUtilities[] {
        const loadedUtilities = this.getUtilities();

        return loadedUtilities;
    }

    public getUtilities(): MagmaUtilities[] {
        return [];
    }

    public getTools(): MagmaTool[] {
        return [];
    }

    public getMiddleware(): MagmaMiddleware[] {
        return [];
    }

    public getHooks(): MagmaHook[] {
        return [];
    }

    public getJobs(): MagmaJob[] {
        return [];
    }

    public getReceivers(): MagmaReceiver[] {
        return [];
    }

    public get tools(): MagmaTool[] {
        const agentTools = loadTools(this);
        const loadedTools = this.getTools();
        const utilityTools = this.utilities.flatMap((u) => u.tools.filter(Boolean));
        return agentTools.concat(loadedTools).concat(utilityTools);
    }

    public get middleware(): MagmaMiddleware[] {
        const agentMiddleware = loadMiddleware(this);
        const loadedMiddleware = this.getMiddleware();
        const utilityMiddleware = this.utilities.flatMap((u) => u.middleware.filter(Boolean));
        return agentMiddleware
            .concat(loadedMiddleware)
            .concat(utilityMiddleware)
            .sort((a, b) => (a.order ?? Number.MAX_VALUE) - (b.order ?? Number.MAX_VALUE));
    }

    public get hooks(): MagmaHook[] {
        const agentHooks = loadHooks(this);
        const loadedHooks = this.getHooks();
        const utilityHooks = this.utilities.flatMap((u) => u.hooks.filter(Boolean));
        return agentHooks.concat(loadedHooks).concat(utilityHooks);
    }

    public get jobs(): MagmaJob[] {
        const agentJobs = loadJobs(this);
        const loadedJobs = this.getJobs();
        const utilityJobs = this.utilities.flatMap((u) => u.jobs.filter(Boolean));
        return agentJobs.concat(loadedJobs).concat(utilityJobs);
    }

    public get receivers(): MagmaReceiver[] {
        const agentReceivers = loadReceivers(this);
        const loadedReceivers = this.getReceivers();
        const utilityReceivers = this.utilities.flatMap((u) => u.receivers.filter(Boolean));
        return agentReceivers.concat(loadedReceivers).concat(utilityReceivers);
    }

    /* EVENT HANDLERS */

    getSystemPrompts(): MagmaSystemMessage[] {
        return [];
    }

    onError(error: Error): Promise<void> | void {
        this.log(`Error: ${error.message}`);
        throw error;
    }

    onStreamChunk(chunk: MagmaStreamChunk, send: MagmaSendFunction): Promise<void> | void {
        chunk;
        return;
    }

    onUsageUpdate(usage: MagmaUsage): Promise<void> | void {
        usage;
        return;
    }

    onCleanup(): Promise<void> | void {
        return;
    }
}
