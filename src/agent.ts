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
} from './types';
import { Provider } from './providers';
import {
    hash,
    loadHooks,
    loadJobs,
    loadMiddleware,
    loadTools,
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
    private providerConfig: MagmaProviderConfig;
    private retryCount: number;
    private messages: MagmaMessage[];
    private middlewareRetries: Record<number, number>;
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
            this.log(`Error during cleanup: ${error.message ?? 'Unknown'}`);
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
     * Manually trigger a tool call in the context of the conversation
     *
     * @param args.name The name of the tool to run
     * @param args.tool The Magma tool to run
     * Either `name` or `tool` must be provided. Tool will be prioritized if both are provided.
     * @param args.addToConversation Whether the tool call should be added to the conversation history (default: false)
     * @throws if no tool matching tool is found
     */
    public async trigger({
        args,
        config,
        parentRequestIds = [],
        trace = [],
        onTrace,
    }: {
        args: {
            name?: string;
            tool?: MagmaTool;
            addToConversation?: boolean;
        };
        config?: MagmaProviderConfig;
        parentRequestIds?: string[];
        trace?: TraceEvent[];
        onTrace?: (trace: TraceEvent[]) => void;
    }): Promise<MagmaAssistantMessage | MagmaToolResult> {
        const requestId = Math.random().toString(36).substring(2, 15);
        sanitizeMessages(this.messages);
        trace.push({
            type: 'trigger',
            phase: 'start',
            requestId,
            timestamp: Date.now(),
            data: {
                message: this.messages.at(-1),
                parentRequestIds,
                config,
            },
        });
        const tool = args.tool ?? this.tools.find((t) => t.name === args.name);

        if (!tool) throw new Error('No tool found to trigger');

        args.addToConversation ??= false;

        try {
            // this promise will resolve when either trigger finishes or the abort controller is aborted
            const triggerPromise = new Promise<MagmaAssistantMessage | MagmaToolResult>(
                async (resolve) => {
                    for (const [key, controller] of this.abortControllers.entries()) {
                        if (!parentRequestIds?.includes(key)) {
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

                    const startingProviderConfig = this.providerConfig;

                    if (config?.['provider']) {
                        this.setProviderConfig(config);
                    }

                    const provider = Provider.factory(this.providerConfig.provider);

                    const messages = [
                        ...this.getSystemPrompts().map((s) => new MagmaSystemMessage(s)),
                        ...this.getMessages(this.messageContext),
                    ];
                    if (messages.length > 0 && messages.at(-1).role === 'assistant') {
                        messages[messages.length - 1].blocks = messages[
                            messages.length - 1
                        ].blocks.filter((block) => block.type !== 'tool_call');
                    }

                    const completionConfig: MagmaCompletionConfig = {
                        providerConfig: this.providerConfig,
                        messages,
                        tools: [tool],
                        tool_choice: tool.name,
                        stream: this.stream,
                    };

                    if (!this.abortControllers.has(requestId)) {
                        return resolve(null);
                    }

                    const completion = await provider.makeCompletionRequest({
                        config: completionConfig,
                        onStreamChunk: this.onStreamChunk.bind(this),
                        attempt: 0,
                        signal: this.abortControllers.get(requestId)?.signal,
                        agent: this,
                    });

                    if (completion === null) {
                        return resolve(null);
                    }

                    this.setProviderConfig(startingProviderConfig);

                    this.onUsageUpdate(completion.usage);

                    const call = completion.message;

                    // If the tool call is not `inConversation`, we just return the result
                    if (!args.addToConversation) {
                        const toolResults = await this.executeTools({
                            message: call,
                            allowList: [tool.name],
                            trace,
                            requestId,
                        });
                        trace.push({
                            type: 'trigger',
                            phase: 'end',
                            status: 'success',
                            requestId,
                            timestamp: Date.now(),
                            data: {
                                message: this.messages.at(-1),
                                parentRequestIds,
                                config,
                                toolResults: toolResults,
                                usage: completion.usage, // Individual usage for this specific trigger call
                            },
                        });

                        // Call trace callback if provided
                        if (onTrace) {
                            onTrace([...trace]);
                        }

                        return resolve(toolResults[0]);
                    }

                    let modifiedMessage: MagmaMessage;
                    try {
                        modifiedMessage = await this.runMiddleware({
                            trigger: 'onCompletion',
                            message: completion.message,
                            trace,
                            requestId,
                        });
                        this.messages.push(modifiedMessage);
                    } catch (error) {
                        if (this.messages.at(-1).role === 'assistant') {
                            this.messages.pop();
                        }

                        this.addMessage({
                            role: 'system',
                            content: error.message,
                        });

                        return resolve(
                            await this.trigger({
                                args,
                                config,
                                parentRequestIds: [...parentRequestIds, requestId],
                                trace,
                                onTrace,
                            })
                        );
                    }

                    if (!modifiedMessage) {
                        throw new Error(
                            `Catastrophic error: failed onCompletion middleware ${kMiddlewareMaxRetries} times`
                        );
                    }

                    const toolResults = await this.executeTools({
                        message: completion.message,
                        allowList: [tool.name],
                        trace,
                        requestId,
                    });

                    if (toolResults.length > 0) {
                        this.messages.push(
                            new MagmaMessage({
                                role: 'user',
                                blocks: toolResults.map((t) => ({
                                    type: 'tool_result',
                                    tool_result: t,
                                })),
                            })
                        );

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

                    trace.push({
                        type: 'trigger',
                        phase: 'end',
                        status: 'success',
                        requestId,
                        timestamp: Date.now(),
                        data: {
                            message: this.messages.at(-1),
                            parentRequestIds,
                            config,
                            result: modifiedMessage,
                            usage: completion.usage, // Individual usage for this specific trigger call
                        },
                    });

                    // Call trace callback if provided
                    if (onTrace) {
                        onTrace([...trace]);
                    }

                    return resolve(modifiedMessage as MagmaAssistantMessage);
                }
            );

            return await triggerPromise;
        } catch (error) {
            trace.push({
                type: 'trigger',
                phase: 'end',
                status: 'error',
                requestId,
                timestamp: Date.now(),
                data: {
                    message: this.messages.at(-1),
                    parentRequestIds,
                    config,
                    error: error.message,
                },
            });

            // Call trace callback even on error
            if (onTrace) {
                onTrace([...trace]);
            }

            try {
                this.onError(error);
            } catch {
                throw error;
            }
        } finally {
            this.abortControllers.delete(requestId);
        }
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
        trace.push({
            type: 'main',
            phase: 'start',
            requestId,
            timestamp: Date.now(),
            data: {
                message: this.messages.at(-1),
                parentRequestIds,
                config,
            },
        });
        try {
            // this promise will resolve when either main finishes or the abort controller is aborted
            const mainPromise = new Promise<MagmaAssistantMessage | null>(async (resolve) => {
                // if we have an abort controller, abort it
                // create a new abort controller for this request
                // add an onabort handler to the abort controller that will resolve the promise with null
                // if the abort controller is aborted
                // if the abort controller is not aborted, the promise will resolve with the result of the main function

                for (const [key, controller] of this.abortControllers.entries()) {
                    if (!parentRequestIds.includes(key)) {
                        // console.log('Aborting and removing controller for request', key);
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

                // Call 'preCompletion' middleware
                const lastMessage = this.messages[this.messages.length - 1];
                if (!lastMessage) {
                    console.error('Cannot generate message without input');
                    return resolve(null);
                }

                let middlewareResult: MagmaMessage;
                try {
                    middlewareResult = await this.runMiddleware({
                        trigger: 'preCompletion',
                        message: lastMessage,
                        trace,
                        requestId,
                    });
                } catch (error) {
                    if (lastMessage.role === 'user') {
                        this.messages.pop();
                    }

                    // console.log('Error in preCompletion middleware', error);

                    return resolve(
                        new MagmaAssistantMessage({
                            role: 'assistant',
                            content: error.message,
                        })
                    );
                }

                if (!middlewareResult) {
                    throw new Error(
                        `Catastrophic error: failed preCompletion middleware ${kMiddlewareMaxRetries} times`
                    );
                }

                this.messages[this.messages.length - 1] = middlewareResult;

                const startingProviderConfig = this.providerConfig;

                if (config?.['provider']) {
                    this.setProviderConfig(config);
                }

                const provider = Provider.factory(this.providerConfig.provider);

                // console.log('Messages before completion', JSON.stringify(this.messages, null, 2));
                const completionConfig: MagmaCompletionConfig = {
                    providerConfig: this.providerConfig,
                    messages: [
                        ...this.getSystemPrompts().map((s) => new MagmaSystemMessage(s)),
                        ...this.getMessages(this.messageContext),
                    ],
                    stream: this.stream,
                    tools: this.tools.filter((t) => t.enabled(this)),
                };

                if (!this.abortControllers.has(requestId)) {
                    // console.log('Controller for request', requestId, 'not found, returning null');
                    return resolve(null);
                }

                const completion = await provider.makeCompletionRequest({
                    config: completionConfig,
                    onStreamChunk: this.onStreamChunk.bind(this),
                    attempt: 0,
                    signal: this.abortControllers.get(requestId)?.signal,
                    agent: this,
                });

                if (completion === null) {
                    // console.log('Completion returned null, returning null for request', requestId);
                    return resolve(null);
                }

                this.setProviderConfig(startingProviderConfig);

                this.onUsageUpdate(completion.usage);

                let modifiedMessage: MagmaMessage;
                try {
                    modifiedMessage = await this.runMiddleware({
                        trigger: 'onCompletion',
                        message: completion.message,
                        trace,
                        requestId,
                    });
                    this.messages.push(modifiedMessage);
                } catch (error) {
                    if (this.messages.at(-1).role === 'assistant') {
                        this.messages.pop();
                    }

                    this.addMessage({
                        role: 'system',
                        content: error.message,
                    });

                    // console.log('Error in onCompletion middleware, retrying', error);

                    return resolve(
                        await this.main({
                            config,
                            parentRequestIds: [...parentRequestIds, requestId],
                            trace,
                            onTrace,
                        })
                    );
                }

                if (!modifiedMessage) {
                    throw new Error(
                        `Catastrophic error: failed onCompletion middleware ${kMiddlewareMaxRetries} times`
                    );
                }

                const toolResults = await this.executeTools({
                    message: completion.message,
                    trace,
                    requestId,
                });

                if (!this.abortControllers.has(requestId)) {
                    // console.log('Controller for request', requestId, 'not found, returning null');
                    return resolve(null);
                }

                if (toolResults.length > 0) {
                    this.messages.push(
                        new MagmaMessage({
                            role: 'user',
                            blocks: toolResults.map((t) => ({
                                type: 'tool_result',
                                tool_result: t,
                            })),
                        })
                    );

                    // console.log('Tool results found, retrying');

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

                try {
                    modifiedMessage = await this.runMiddleware({
                        trigger: 'onMainFinish',
                        message: modifiedMessage,
                        trace,
                        requestId,
                    });
                    if (modifiedMessage) {
                        this.messages[this.messages.length - 1] = modifiedMessage;
                    }
                } catch (error) {
                    if (this.messages.at(-1).role === 'assistant') {
                        this.messages.pop();
                    }

                    this.addMessage({
                        role: 'system',
                        content: error.message,
                    });

                    // console.log('Error in onMainFinish middleware, retrying', error);

                    return resolve(
                        await this.main({
                            config,
                            parentRequestIds: [...parentRequestIds, requestId],
                            trace,
                            onTrace,
                        })
                    );
                }

                if (!modifiedMessage) {
                    throw new Error(
                        `Catastrophic error: failed onMainFinish middleware ${kMiddlewareMaxRetries} times`
                    );
                }

                try {
                    modifiedMessage = await this.runMiddleware({
                        trigger: 'postProcess',
                        message: modifiedMessage,
                        trace,
                        requestId,
                    });
                } catch (error) {
                    if (this.messages.at(-1).role === 'assistant') {
                        this.messages.pop();
                    }

                    this.addMessage({
                        role: 'system',
                        content: error.message,
                    });

                    // console.log('Error in postProcess middleware, retrying', error);

                    return resolve(
                        await this.main({
                            config,
                            parentRequestIds: [...parentRequestIds, requestId],
                            trace,
                            onTrace,
                        })
                    );
                }

                trace.push({
                    type: 'main',
                    phase: 'end',
                    status: 'success',
                    requestId,
                    timestamp: Date.now(),
                    data: {
                        message: this.messages.at(-1),
                        parentRequestIds,
                        config,
                        result: modifiedMessage,
                        usage: completion.usage, // Individual usage for this specific call
                    },
                });

                // Call trace callback if provided
                if (onTrace) {
                    onTrace([...trace]);
                }

                return resolve(modifiedMessage as MagmaAssistantMessage);
            });

            return await mainPromise;
        } catch (error) {
            trace.push({
                type: 'main',
                phase: 'end',
                status: 'error',
                requestId,
                timestamp: Date.now(),
                data: {
                    message: this.messages.at(-1),
                    parentRequestIds,
                    config,
                    error: error.message,
                },
            });

            // Call trace callback even on error
            if (onTrace) {
                onTrace([...trace]);
            }

            try {
                this.onError(error);
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
                    providerConfig.client ??= new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
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
     * @param filter optional filter to remove a specific message
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
        if (messages.length && messages.length > 0 && messages.at(0).getToolResults().length > 0) {
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
                cron.schedule(job.schedule, job.handler.bind(this), job.options)
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
     * @param call MagmaToolCall tool call to run
     * @returns completion to continue the conversation
     */
    private async executeTools({
        message,
        allowList = [],
        trace,
        requestId,
    }: {
        message: MagmaMessage;
        allowList?: string[];
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaToolResult[]> {
        try {
            // run preToolExecution middleware
            let modifiedMessage = await this.runMiddleware({
                trigger: 'preToolExecution',
                message,
                trace,
                requestId,
            });

            if (!modifiedMessage) {
                throw new Error(
                    `Catastrophic error: failed preToolExecution middleware ${kMiddlewareMaxRetries} times`
                );
            }

            let toolResultBlocks: MagmaToolResultBlock[] = [];

            // execute the tool calls that didn't throw errors in preToolExecution middleware
            for (const toolCall of modifiedMessage.getToolCalls()) {
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
                        const errorMessage = `Tool Execution Failed for ${toolCall.fn_name}() - ${error.message ?? 'Unknown'}`;
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
                                error: error.message,
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

            modifiedMessage = await this.runMiddleware({
                trigger: 'onToolExecution',
                message: new MagmaMessage({
                    role: 'assistant',
                    blocks: toolResultBlocks,
                }),
                trace,
                requestId,
            });

            if (!modifiedMessage) {
                throw new Error(
                    `Catastrophic error: failed onToolExecution middleware ${kMiddlewareMaxRetries} times`
                );
            }

            const toolResults = modifiedMessage.getToolResults();

            return toolResults;
        } catch (error) {
            throw error;
        }
    }

    private async runMiddleware<T extends MagmaMiddlewareTriggerType>({
        trigger,
        message,
        trace,
        requestId,
    }: {
        trigger: T;
        message: MagmaMessage;
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaMessage | null> {
        if (message.role === 'system') return message;

        // Determine whether there are relevant middleware actions to run
        const middleware = this.middleware.filter((f) => f.trigger === trigger);
        if (middleware.length === 0) return message;

        const messageResult: MagmaMessage = new MagmaMessage({
            role: message.role,
            blocks: [],
        });

        const middlewareErrors: string[] = [];

        // Run the middleware for each block
        for (const item of message.blocks) {
            let middlewarePayload: MagmaMiddlewareParamType<MagmaMiddlewareTriggerType>;

            switch (item.type) {
                case 'text':
                    // If the middleware is preCompletion and its an assistant message, we skip it
                    if (trigger === 'preCompletion' && message.role === 'assistant') {
                        messageResult.blocks.push(item);
                        continue;
                    }
                    // If the middleware is onCompletion and its a user message, we skip it
                    if (trigger === 'onCompletion' && message.role === 'user') {
                        messageResult.blocks.push(item);
                        continue;
                    }

                    // If the middleware is not preCompletion, onCompletion, onMainFinish, or postProcess we skip it
                    if (
                        trigger !== 'preCompletion' &&
                        trigger !== 'onCompletion' &&
                        trigger !== 'onMainFinish' &&
                        trigger !== 'postProcess'
                    ) {
                        messageResult.blocks.push(item);
                        continue;
                    }
                    middlewarePayload = item.text as MagmaMiddlewareParamType<
                        'preCompletion' | 'onCompletion' | 'onMainFinish' | 'postProcess'
                    >;
                    break;
                case 'tool_call':
                    // If the middleware is not preToolExecution, we skip it
                    if (trigger !== 'preToolExecution') {
                        messageResult.blocks.push(item);
                        continue;
                    }
                    middlewarePayload = {
                        id: item.tool_call.id,
                        fn_name: item.tool_call.fn_name,
                        fn_args: item.tool_call.fn_args,
                    } as MagmaMiddlewareParamType<'preToolExecution'>;
                    break;
                case 'tool_result':
                    // If the middleware is not onToolExecution, we skip it
                    if (trigger !== 'onToolExecution') {
                        messageResult.blocks.push(item);
                        continue;
                    }
                    middlewarePayload = {
                        id: item.tool_result.id,
                        fn_name: item.tool_result.fn_name,
                        result: item.tool_result.result,
                        error: item.tool_result.error,
                        call: item.tool_result.call,
                    } as MagmaMiddlewareParamType<'onToolExecution'>;
                    break;
                default:
                    messageResult.blocks.push(item);
                    continue;
            }

            for (const mdlwr of middleware) {
                try {
                    trace.push({
                        type: 'middleware',
                        phase: 'start',
                        requestId,
                        timestamp: Date.now(),
                        data: {
                            middleware: mdlwr.name,
                            middlewarePayload,
                            message: message,
                        },
                    });
                    // Run middleware target action on payload completion
                    const middlewareResult = (await mdlwr.action(
                        middlewarePayload,
                        this
                    )) as MagmaMiddlewareReturnType<T>;
                    trace.push({
                        type: 'middleware',
                        phase: 'end',
                        status: 'success',
                        requestId,
                        timestamp: Date.now(),
                        data: {
                            middleware: mdlwr.name,
                            middlewarePayload,
                            message: message,
                            middlewareResult,
                        },
                    });
                    if (middlewareResult) {
                        middlewarePayload = middlewareResult;
                    }
                } catch (error) {
                    const mHash = hash(mdlwr.action.toString());
                    this.middlewareRetries[mHash] ??= 0;
                    this.middlewareRetries[mHash] += 1;

                    // Add the error to the middlewareErrors array
                    middlewareErrors.push(error.message);

                    if (this.middlewareRetries[mHash] >= kMiddlewareMaxRetries) {
                        this.log(
                            `${trigger} middleware failed to recover after ${kMiddlewareMaxRetries} attempts`
                        );

                        if (mdlwr.critical) {
                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'error',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    middlewarePayload,
                                    message: message,
                                    error: error.message,
                                },
                            });
                            return null;
                        } else {
                            trace.push({
                                type: 'middleware',
                                phase: 'end',
                                status: 'error',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    middleware: mdlwr.name,
                                    middlewarePayload,
                                    message: message,
                                    error: error.message,
                                },
                            });
                            middlewareErrors.pop();
                            delete this.middlewareRetries[mHash];
                            continue;
                        }
                    } else {
                        trace.push({
                            type: 'middleware',
                            phase: 'end',
                            status: 'error',
                            requestId,
                            timestamp: Date.now(),
                            data: {
                                middleware: mdlwr.name,
                                middlewarePayload,
                                message: message,
                                error: error.message,
                            },
                        });
                    }

                    this.log(
                        `'${trigger}' middleware threw an error - ${error.message ?? 'Unknown'}`
                    );
                }
            }

            switch (item.type) {
                case 'text':
                    messageResult.blocks.push({
                        type: 'text',
                        text: middlewarePayload as MagmaMiddlewareParamType<
                            'preCompletion' | 'onCompletion' | 'onMainFinish' | 'postProcess'
                        >,
                    });
                    break;
                case 'tool_call':
                    if (middlewareErrors.length > 0) {
                        (middlewarePayload as MagmaMiddlewareParamType<'preToolExecution'>).error =
                            middlewareErrors.join('\n');
                    }
                    messageResult.blocks.push({
                        type: 'tool_call',
                        tool_call:
                            middlewarePayload as MagmaMiddlewareParamType<'preToolExecution'>,
                    });
                    break;
                case 'tool_result':
                    if (middlewareErrors.length > 0) {
                        (middlewarePayload as MagmaMiddlewareParamType<'onToolExecution'>).result =
                            middlewareErrors.join('\n');
                        (middlewarePayload as MagmaMiddlewareParamType<'onToolExecution'>).error =
                            true;
                    }
                    messageResult.blocks.push({
                        type: 'tool_result',
                        tool_result:
                            middlewarePayload as MagmaMiddlewareParamType<'onToolExecution'>,
                    });
                    break;
            }
        }

        if (middlewareErrors.length === 0) {
            // Remove errors for middleware that was just run as everything was OK
            middleware.forEach(
                (mdlwr) => delete this.middlewareRetries[hash(mdlwr.action.toString())]
            );
        } else if (trigger !== 'preToolExecution' && trigger !== 'onToolExecution') {
            throw new Error(middlewareErrors.join('\n'));
        }

        return messageResult;
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
