import {
    MagmaAssistantMessage,
    MagmaMessage,
    MagmaProviderConfig,
    MagmaTool,
    MagmaMiddleware,
    MagmaMiddlewareTriggerType,
    MagmaStreamChunk,
    MagmaToolResult,
    MagmaMiddlewareReturnType,
    MagmaUtilities,
    MagmaHook,
    MagmaJob,
    MagmaCompletionConfig,
    MagmaToolResultBlock,
    MagmaMessageType,
    MagmaMiddlewareParamType,
    MagmaSystemMessageType,
    MagmaSystemMessage,
    TraceEvent,
    MagmaUserMessage,
    MagmaTextBlock,
    MagmaToolCallBlock,
    MagmaToolCall,
} from './types';
import { Provider } from './providers';
import {
    loadHooks,
    loadJobs,
    loadMiddleware,
    loadTools,
    parseErrorToError,
    parseErrorToString,
    sanitizeMessages,
} from './helpers/index';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import cron from 'node-cron';
import { GoogleGenerativeAI } from '@google/generative-ai';

const kMiddlewareMaxRetries = 5;

type AgentProps = MagmaProviderConfig & {
    verbose?: boolean;
    messageContext?: number;
    stream?: boolean;
};

export class MagmaAgent {
    verbose?: boolean;
    stream: boolean = false;
    private providerConfig: MagmaProviderConfig = {
        provider: 'openai',
        model: 'gpt-4.1',
    };
    private retryCount: number;
    private messages: MagmaMessage[];
    private middlewareRetries: Record<string, number>;
    private messageContext: number;
    private scheduledJobs: cron.ScheduledTask[];
    private abortControllers: Map<string, AbortController> = new Map();

    constructor(args?: AgentProps) {
        this.messageContext = args?.messageContext ?? 20;
        this.verbose = args?.verbose ?? false;
        this.stream = args?.stream ?? false;

        args ??= {
            provider: 'anthropic',
            model: 'claude-3-5-sonnet-latest',
        };

        const providerConfig = {
            provider: args.provider,
            model: args.model,
            settings: args.settings,
            client: args.client,
        } as MagmaProviderConfig;

        this.setProviderConfig(providerConfig);

        this.messages = [];
        this.retryCount = 0;
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

    /**
     * Optional method to receive input from the user
     * @param message message object received from the user - type to be defined by extending class
     */
    public async receive?(message: any): Promise<void> {}

    public async cleanup(): Promise<void> {
        try {
            await this.onCleanup();
        } catch (error) {
            this.log(`Error during cleanup: ${parseErrorToString(error)}`)
        } finally {
            this._cleanup();
        }
    }

    private async _cleanup(): Promise<void> {
        this.abortControllers.forEach((controller) => controller.abort());
        this.abortControllers.clear();

        this.messages = [];

        this.log('Agent cleanup complete');
    }

    /**
     * Handles the completion process by interacting with the configured provider and executing middleware.
     * This function performs the following steps:
     * 1. Retrieves the provider instance based on the configured provider name.
     * 2. Executes the 'preCompletion' middleware, which can modify the last message before making the AI request.
     * 3. Configures the completion request with necessary parameters such as model, messages, and tools.
     * 4. Sends the completion request to the provider and updates usage statistics.
     * 5. If the response indicates a 'tool_call', runs the 'preToolExecution' middleware and executes the appropriate tool.
     * 6. If not a tool call, runs the 'onCompletion' middleware with the returned message.
     *
     * If an error occurs during the process, the function will either trigger an error update handler or rethrow the error.
     *
     * @returns { MagmaMessage } A promise that resolves to a `MagmaMessage` object, which is either the final message
     * returned from the provider or the result of a tool execution
     *
     * @throws Will rethrow the error if no `onError` handler is defined
     */
    public async main(args?: {
        config?: MagmaProviderConfig;
        parentRequestIds?: string[];
        trace?: TraceEvent[];
        onTrace?: (trace: TraceEvent[]) => void;
    }): Promise<MagmaAssistantMessage | null> {
        const { config, parentRequestIds = [], trace = [], onTrace } = args ?? {};

        const requestId = Math.random().toString(36).substring(2, 15);
        sanitizeMessages(this.messages);
        try {
            // this promise will resolve when either main finishes or the abort controller is aborted
            const mainPromise = new Promise<MagmaAssistantMessage | null>(
                async (resolve, reject) => {
                    try {
                        // if we have an abort controller, abort it
                        // create a new abort controller for this request
                        // add an onabort handler to the abort controller that will resolve the promise with null
                        // if the abort controller is aborted
                        // if the abort controller is not aborted, the promise will resolve with the result of the main function

                        for (const [key, controller] of this.abortControllers.entries()) {
                            if (!parentRequestIds.includes(key)) {
                                controller.abort();
                                this.abortControllers.delete(key);
                            }
                        }

                        const abortController = new AbortController();
                        this.abortControllers.set(requestId, abortController);
                        abortController.signal.onabort = () => {
                            this.abortControllers.delete(requestId);
                            return resolve(null);
                        };

                        // Find the most recent user message
                        let userMessage: MagmaUserMessage | null = null;
                        let userMessageIndex: number | null = null;
                        for (let i = this.messages.length - 1; i >= 0; i--) {
                            if (this.messages[i].role === 'user') {
                                userMessage = this.messages[i] as MagmaUserMessage;
                                userMessageIndex = i;
                                break;
                            }
                        }

                        // If we don't have a last user message, we can't generate a response
                        if (userMessage === null || userMessageIndex === null) {
                            this.log('Cannot generate message without user input');
                            return resolve(null);
                        }

                        // Run the preCompletion middleware
                        let preCompletionMiddlewareResult: MagmaUserMessage;
                        try {
                            preCompletionMiddlewareResult = await this.runPreCompletionMiddleware({
                                message: userMessage,
                                trace,
                                requestId,
                            });
                        } catch (error) {
                            // If the preCompletion middleware fails, we should remove the last message
                            this.messages.pop();

                            this.log(
                                `Error in preCompletion middleware: ${parseErrorToString(error)}`
                            );

                            // Return the error message as the assistant message
                            return resolve(
                                new MagmaAssistantMessage({
                                    role: 'assistant',
                                    content: parseErrorToString(error),
                                })
                            );
                        }

                        // Update the last user message with the result of the preCompletion middleware
                        this.messages[userMessageIndex] = preCompletionMiddlewareResult;

                        // Save the starting provider config
                        const startingProviderConfig = this.providerConfig;

                        // If a new provider config is provided, use it for this request
                        if (config?.['provider']) {
                            this.setProviderConfig(config);
                        }

                        // Get the provider for this request
                        const provider = Provider.factory(this.providerConfig.provider);

                        // Create the completion config for this request
                        const completionConfig: MagmaCompletionConfig = {
                            providerConfig: this.providerConfig,
                            messages: [
                                ...this.getSystemPrompts().map((s) => new MagmaSystemMessage(s)),
                                ...this.getMessages(this.messageContext),
                            ],
                            stream: this.stream,
                            tools: this.tools.filter((t) => t.enabled(this)),
                        };

                        // Ensure the abort controller is still active
                        if (!this.abortControllers.has(requestId)) {
                            return resolve(null);
                        }

                        // Make the completion request
                        const completion = await provider.makeCompletionRequest({
                            config: completionConfig,
                            onStreamChunk: this.onStreamChunk.bind(this),
                            attempt: 0,
                            signal: this.abortControllers.get(requestId)?.signal,
                            agent: this,
                            trace,
                            requestId,
                        });

                        if (completion === null) {
                            this.log(
                                `Completion returned null, returning null for request ${requestId}`
                            );
                            return resolve(null);
                        }

                        // Reset the provider config to the starting provider config
                        this.setProviderConfig(startingProviderConfig);

                        // Call the onUsageUpdate callback
                        this.onUsageUpdate(completion.usage);

                        // Add the completion message to the messages array
                        this.messages.push(completion.message);

                        // Run the onCompletion middleware
                        let onCompletionMiddlewareResult: MagmaAssistantMessage | null;
                        try {
                            onCompletionMiddlewareResult = await this.runOnCompletionMiddleware({
                                message: completion.message as MagmaAssistantMessage,
                                trace,
                                requestId,
                            });
                        } catch (error) {
                            // If the onCompletion middleware fails, we should remove the last message
                            this.messages.pop();

                            this.log(
                                `Error in onCompletion middleware: ${parseErrorToString(error)}`
                            );

                            // Add the error message to the messages array
                            this.addMessage({
                                role: 'system',
                                content: parseErrorToString(error),
                            });

                            // Trigger another completion with the error message as context
                            return resolve(
                                await this.main({
                                    config,
                                    parentRequestIds: [...parentRequestIds, requestId],
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
                        this.messages[this.messages.length - 1] = onCompletionMiddlewareResult;

                        // If the onCompletion middleware returns a tool call, we should execute the tools
                        if (onCompletionMiddlewareResult.getToolCalls().length > 0) {
                            let preToolExecutionMiddlewareResult: MagmaAssistantMessage | null;
                            try {
                                preToolExecutionMiddlewareResult =
                                    await this.runPreToolExecutionMiddleware({
                                        message: onCompletionMiddlewareResult,
                                        trace,
                                        requestId,
                                    });
                            } catch (error) {
                                this.messages.pop();

                                this.log(
                                    `Error in preToolExecution middleware: ${parseErrorToString(error)}`
                                );

                                this.addMessage({
                                    role: 'system',
                                    content: parseErrorToString(error),
                                });

                                return resolve(
                                    await this.main({
                                        config,
                                        parentRequestIds: [...parentRequestIds, requestId],
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

                            // Execute the tools
                            const toolResultsUserMessage = await this.executeTools({
                                message: preToolExecutionMiddlewareResult,
                                trace,
                                requestId,
                            });

                            const onToolExecutionMiddlewareResult =
                                await this.runOnToolExecutionMiddleware({
                                    message: toolResultsUserMessage,
                                    trace,
                                    requestId,
                                });

                            if (!onToolExecutionMiddlewareResult) {
                                throw new Error(
                                    `Catastrophic error: failed onToolExecution middleware ${kMiddlewareMaxRetries} times`
                                );
                            }

                            // If the abort controller is not active, return null
                            if (!this.abortControllers.has(requestId)) {
                                return resolve(null);
                            }

                            // Add the tool results to the messages array
                            this.messages.push(toolResultsUserMessage);

                            // Trigger another completion because last message was a tool call
                            return resolve(
                                await this.main({
                                    config,
                                    parentRequestIds: [...parentRequestIds, requestId],
                                    trace,
                                    onTrace,
                                })
                            );
                        }

                        // If the onCompletion middleware does not return a tool call, we should run the onMainFinish middleware
                        let onMainFinishMiddlewareResult: MagmaAssistantMessage | null;
                        try {
                            onMainFinishMiddlewareResult = await this.runOnMainFinishMiddleware({
                                message: onCompletionMiddlewareResult,
                                trace,
                                requestId,
                            });
                        } catch (error) {
                            // If the onMainFinish middleware fails, we should remove the last message
                            this.messages.pop();

                            this.log(
                                `Error in onMainFinish middleware: ${parseErrorToString(error)}`
                            );

                            // Add the error message to the messages array
                            this.addMessage({
                                role: 'system',
                                content: parseErrorToString(error),
                            });

                            return resolve(
                                await this.main({
                                    config,
                                    parentRequestIds: [...parentRequestIds, requestId],
                                    trace,
                                    onTrace,
                                })
                            );
                        }

                        // We don't update the last message with the result of the onMainFinish middleware
                        // Returning from onMainFinish will update the main output, but not the message history

                        // Call trace callback if provided
                        if (onTrace) {
                            onTrace([...trace]);
                        }

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
     * Set the provider configuration for the agent
     * @param providerConfig provider configuration
     */
    public setProviderConfig(providerConfig: MagmaProviderConfig): void {
        if (!providerConfig.client && !providerConfig.provider) {
            throw new Error('Provider client or provider must be defined');
        }

        // Set the client based on the provider if not provided
        if (!providerConfig.client) {
            switch (providerConfig.provider) {
                case 'openai':
                    providerConfig.client ??= new OpenAI();
                    break;
                case 'anthropic':
                    providerConfig.client ??= new Anthropic();
                    break;
                case 'groq':
                    providerConfig.client ??= new Groq();
                    break;
                case 'google':
                    providerConfig.client ??= new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
                    break;
                default:
                    throw new Error('Invalid provider');
            }
        }

        this.providerConfig = providerConfig;
    }

    /**
     * Store a message in the agent context
     *
     * @param content content of the message to store
     * @param role message role (default: user)
     */
    public addMessage(message: MagmaMessageType): void {
        const newMessage = new MagmaMessage(message);

        // Validate images are base64 data, not URLs
        for (const image of newMessage.getImages()) {
            if (
                (this.providerConfig.provider === 'anthropic' ||
                    this.providerConfig.provider === 'google') &&
                image.type === 'image/url'
            ) {
                throw new Error('Image URLs are not supported by Anthropic');
            }
        }

        this.messages.push(newMessage);
    }

    /**
     * Set the messages for the agent
     * @param messages messages to set
     */
    public setMessages(messages: MagmaMessage[]): void {
        this.messages = messages;
    }

    /**
     * Remove a message from the agent context
     * If no filter is provided, the last message is removed
     *
     * @param filter optional, remove messages that match the filter
     */
    public removeMessage(filter?: (message: MagmaMessage) => boolean): void {
        if (filter) {
            this.messages = this.messages.filter((message) => !filter(message));
        } else {
            this.messages.pop();
        }
    }

    /**
     * Get the last N messages from the agent context
     * @param slice number of messages to return (default: 20)
     * @returns array of messages
     */
    public getMessages(slice: number = 20) {
        if (slice === -1) return this.messages;

        let messages = this.messages.slice(-slice);
        if (messages.length && messages.length > 0 && messages[0].getToolResults().length > 0) {
            messages = messages.slice(1);
        }

        return messages;
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
    }: {
        message: MagmaAssistantMessage;
        allowList?: string[];
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaUserMessage> {
        try {
            let toolResultBlocks: MagmaToolResultBlock[] = [];

            // execute the tool calls
            for (const toolCall of message.getToolCalls()) {
                let toolResult: MagmaToolResult;

                if (toolCall.error) {
                    toolResult = {
                        id: toolCall.id,
                        fn_name: toolCall.fn_name,
                        result: toolCall.error,
                        error: true,
                        call: toolCall,
                    };
                } else {
                    try {
                        const tool = this.tools
                            .filter((t) => t.enabled(this) || allowList.includes(t.name))
                            .find((t) => t.name === toolCall.fn_name);
                        if (!tool)
                            throw new Error(
                                `No tool found to handle call for ${toolCall.fn_name}()`
                            );

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

                        const result = await tool.target(toolCall, this);

                        if (!result) {
                            this.log(`Tool execution failed for ${toolCall.fn_name}()`);
                        }

                        toolResult = {
                            id: toolCall.id,
                            result: result ?? 'No result returned',
                            error: false,
                            fn_name: toolCall.fn_name,
                            call: toolCall,
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

                        this.retryCount = 0;
                    } catch (error) {
                        const errorMessage = `Tool Execution Failed for ${toolCall.fn_name}() - ${parseErrorToString(error)}`;
                        this.log(errorMessage);

                        trace.push({
                            type: 'tool_execution',
                            phase: 'end',
                            status: 'error',
                            requestId,
                            timestamp: Date.now(),
                            data: {
                                toolCall,
                                toolName: toolCall.fn_name,
                                error: parseErrorToString(error),
                            },
                        });

                        toolResult = {
                            id: toolCall.id,
                            result: errorMessage,
                            error: true,
                            fn_name: toolCall.fn_name,
                            call: toolCall,
                        };
                    }
                }

                toolResultBlocks.push({
                    type: 'tool_result',
                    tool_result: toolResult,
                });
            }

            return new MagmaUserMessage({
                role: 'user',
                blocks: toolResultBlocks,
            });
        } catch (error) {
            throw error;
        }
    }

    private async runPreCompletionMiddleware({
        message,
        trace,
        requestId,
    }: {
        message: MagmaUserMessage;
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaUserMessage> {
        // get preCompletion middleware
        const preCompletionMiddleware = this.middleware.filter(
            (f) => f.trigger === 'preCompletion'
        );
        if (preCompletionMiddleware.length === 0) return message;

        // initialize result message
        const result: MagmaUserMessage = new MagmaUserMessage({
            role: message.role,
            blocks: [],
        });

        try {
            // go through the blocks of the incoming message
            for (let i = 0; i < message.blocks.length; i++) {
                // add the block to the result message
                result.blocks.push(message.blocks[i]);
                // if the block is a text block, we should run each middleware on it
                if (result.blocks[i].type === 'text') {
                    const textBlock = result.blocks[i] as MagmaTextBlock;
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
                                this
                            )) as string;
                            // if the middleware has a return value, we should update the text block in the result message
                            if (middlewareResult) {
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
        return result;
    }

    private async runOnCompletionMiddleware({
        message,
        trace,
        requestId,
    }: {
        message: MagmaAssistantMessage;
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaAssistantMessage | null> {
        // get onCompletion middleware
        const onCompletionMiddleware = this.middleware.filter((f) => f.trigger === 'onCompletion');
        if (onCompletionMiddleware.length === 0) return message;

        // initialize result message
        const result: MagmaAssistantMessage = new MagmaAssistantMessage({
            role: message.role,
            blocks: [],
        });

        try {
            // go through the blocks of the incoming message
            for (let i = 0; i < message.blocks.length; i++) {
                // add the block to the result message
                result.blocks.push(message.blocks[i]);
                // if the block is a text block, we should run each middleware on it
                if (result.blocks[i].type === 'text') {
                    const textBlock = result.blocks[i] as MagmaTextBlock;
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
                                this
                            )) as string;
                            // if the middleware has a return value, we should update the text block in the result message
                            if (middlewareResult) {
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
                                return null;
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
        return result;
    }

    private async runOnMainFinishMiddleware({
        message,
        trace,
        requestId,
    }: {
        message: MagmaAssistantMessage;
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaAssistantMessage | null> {
        // get onMainFinish middleware
        const onMainFinishMiddleware = this.middleware.filter((f) => f.trigger === 'onMainFinish');
        if (onMainFinishMiddleware.length === 0) return message;

        // initialize result message
        const result: MagmaAssistantMessage = new MagmaAssistantMessage({
            role: message.role,
            blocks: [],
        });

        try {
            // go through the blocks of the incoming message
            for (let i = 0; i < message.blocks.length; i++) {
                // add the block to the result message
                result.blocks.push(message.blocks[i]);
                // if the block is a text block, we should run each middleware on it
                if (result.blocks[i].type === 'text') {
                    const textBlock = result.blocks[i] as MagmaTextBlock;
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
                                this
                            )) as string;
                            // if the middleware has a return value, we should update the text block in the result message
                            if (middlewareResult) {
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
                                return null;
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
        return result;
    }

    private async runPreToolExecutionMiddleware({
        message,
        trace,
        requestId,
    }: {
        message: MagmaAssistantMessage;
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaAssistantMessage | null> {
        // get preToolExecution middleware
        const preToolExecutionMiddleware = this.middleware.filter(
            (f) => f.trigger === 'preToolExecution'
        );
        if (preToolExecutionMiddleware.length === 0) return message;

        //initialize result message
        const result: MagmaAssistantMessage = new MagmaAssistantMessage({
            role: message.role,
            blocks: [],
        });

        try {
            // go through the blocks of the incoming message
            for (let i = 0; i < message.blocks.length; i++) {
                // add the block to the result message
                result.blocks.push(message.blocks[i]);
                // if the block is a tool call, we should run each middleware on it
                if (result.blocks[i].type === 'tool_call') {
                    const toolCall = result.blocks[i] as MagmaToolCallBlock;
                    for (const mdlwr of preToolExecutionMiddleware) {
                        try {
                            trace.push({
                                type: 'middleware',
                                phase: 'start',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    input: toolCall.tool_call,
                                },
                            });
                            // run the middleware on the tool call
                            const middlewareResult = (await mdlwr.action(
                                toolCall.tool_call,
                                this
                            )) as MagmaToolCall;
                            // if the middleware has a return value, we should update the tool call in the result message
                            if (middlewareResult) {
                                toolCall.tool_call = middlewareResult;
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
                                return null;
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
        return result;
    }

    private async runOnToolExecutionMiddleware({
        message,
        trace,
        requestId,
    }: {
        message: MagmaUserMessage;
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaUserMessage | null> {
        // get onToolExecution middleware
        const onToolExecutionMiddleware = this.middleware.filter(
            (f) => f.trigger === 'onToolExecution'
        );
        if (onToolExecutionMiddleware.length === 0) return message;

        // initialize result message
        const result: MagmaUserMessage = new MagmaUserMessage({
            role: message.role,
            blocks: [],
        });

        // go through the blocks of the incoming message
        for (let i = 0; i < message.blocks.length; i++) {
            // add the block to the result message
            result.blocks.push(message.blocks[i]);
            // if the block is a tool result, we should run each middleware on it
            if (result.blocks[i].type === 'tool_result') {
                const toolResult = result.blocks[i] as MagmaToolResultBlock;
                for (const mdlwr of onToolExecutionMiddleware) {
                    try {
                        trace.push({
                            type: 'middleware',
                            phase: 'start',
                            requestId,
                            timestamp: Date.now(),
                            data: {
                                middleware: mdlwr.name,
                                input: toolResult.tool_result,
                            },
                        });
                        // run the middleware on the tool result
                        const middlewareResult = (await mdlwr.action(
                            toolResult.tool_result,
                            this
                        )) as MagmaToolResult;
                        // if the middleware has a return value, we should update the tool result in the result message
                        if (middlewareResult) {
                            toolResult.tool_result = middlewareResult;
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

                        this.log(`Error in onToolExecution middleware: ${errorMessage}`);

                        if (this.middlewareRetries[mdlwr.id] >= kMiddlewareMaxRetries) {
                            return null;
                        }

                        toolResult.tool_result.result = errorMessage;
                        toolResult.tool_result.error = true;
                    }
                }
            }
        }

        // return the result message
        return result;
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

    /* EVENT HANDLERS */

    getSystemPrompts(): MagmaSystemMessageType[] {
        return [];
    }

    onError(error: Error): Promise<void> | void {
        this.log(`Error: ${error.message}`);
        throw error;
    }

    onStreamChunk(chunk: MagmaStreamChunk | null): Promise<void> | void {
        chunk;
        return;
    }

    onUsageUpdate(usage: object): Promise<void> | void {
        usage;
        return;
    }

    onCleanup(): Promise<void> | void {
        return;
    }
}
