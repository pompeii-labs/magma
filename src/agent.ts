import {
    MagmaAssistantMessage,
    MagmaMessage,
    MagmaProvider,
    MagmaProviderConfig,
    MagmaSystemMessage,
    MagmaTool,
    MagmaMiddleware,
    MagmaMiddlewareTriggerType,
    MagmaState,
    MagmaStreamChunk,
    MagmaToolResult,
    MagmaMiddlewareReturnType,
    MagmaUtilities,
    MagmaHook,
    MagmaJob,
    MagmaCompletionConfig,
    MagmaToolResultBlock,
    MagmaMessageType,
    MagmaTextBlock,
    MagmaContentBlock,
} from './types';
import { Provider } from './providers';
import { MagmaLogger } from './logger';
import { hash, loadUtilities } from './helpers';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import cron from 'node-cron';
import { GoogleGenerativeAI } from '@google/generative-ai';
const kMiddlewareMaxRetries = 5;

type AgentProps = MagmaProviderConfig & {
    logger?: MagmaLogger;
    messageContext?: number;
    stream?: boolean;
};

export class MagmaAgent {
    id?: string;
    logger?: MagmaLogger;
    state: MagmaState;
    stream: boolean = false;
    private providerConfig: MagmaProviderConfig;
    private retryCount: number;
    private messages: MagmaMessage[];
    private middlewareRetries: Record<number, number>;
    private messageContext: number;
    private abortController: AbortController | null = null;

    constructor(args?: AgentProps) {
        this.messageContext = args?.messageContext ?? 20;
        this.logger = args?.logger;
        this.stream = args?.stream ?? false;

        args ??= {
            provider: 'anthropic',
            model: 'claude-3-5-sonnet-latest',
        };

        const providerConfig = {
            provider: args.provider,
            model: args.model,
            settings: args.settings,
        } as MagmaProviderConfig;

        this.setProviderConfig(providerConfig);

        this.state = new Map();
        this.messages = [];
        this.retryCount = 0;
        this.middlewareRetries = {};

        this.logger?.debug('Agent initialized');
    }

    public async setup?(opts?: object): Promise<void> {}

    /**
     * Optional method to receive input from the user
     * @param message message object received from the user - type to be defined by extending class
     */
    public async receive?(message: any): Promise<void> {}

    public async onEvent?(
        type: 'job' | 'hook' | 'tool' | 'middleware',
        name: string,
        event: any
    ): Promise<void> {}

    public async cleanup(): Promise<void> {
        try {
            await this.onCleanup();
        } catch (error) {
            this.logger?.error(`Error during cleanup: ${error.message ?? 'Unknown'}`);
        } finally {
            this._cleanup();
        }
    }

    private async _cleanup(): Promise<void> {
        this.abortController = null;

        this.messages = [];

        this.logger?.debug('Agent cleanup complete');
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
    public async trigger(
        args: {
            name?: string;
            tool?: MagmaTool;
            addToConversation?: boolean;
        },
        config?: MagmaProviderConfig
    ): Promise<MagmaAssistantMessage | MagmaToolResult> {
        const tool = args.tool ?? this.tools.find((t) => t.name === args.name);

        if (!tool) throw new Error('No tool found to trigger');

        args.addToConversation ??= false;

        const startingProviderConfig = this.providerConfig;

        if (config?.['provider']) {
            this.setProviderConfig(config);
        }

        const provider = Provider.factory(this.providerConfig.provider);

        const messages = [
            new MagmaMessage({ role: 'system', content: this.getSystemPrompt() }),
            ...this.getMessages(this.messageContext),
        ];
        if (messages.length > 0 && messages.at(-1).role === 'assistant') {
            messages[messages.length - 1].content = messages[messages.length - 1].content.filter(
                (block) => block.type !== 'tool_call'
            );
        }

        const completionConfig: MagmaCompletionConfig = {
            providerConfig: this.providerConfig,
            messages,
            tools: [tool],
            tool_choice: tool.name,
            stream: this.stream,
        };

        // Create a new AbortController for this request
        this.abortController = new AbortController();

        const completion = await provider.makeCompletionRequest(
            completionConfig,
            this.onStreamChunk.bind(this),
            0,
            this.abortController?.signal
        );

        this.setProviderConfig(startingProviderConfig);

        this.onUsageUpdate(completion.usage);

        const call = completion.message;

        const toolResultBlocks = await this.executeTools(call);

        // If the tool call is not `inConversation`, we just return the result
        if (!args.addToConversation) {
            return toolResultBlocks[0].tool_result;
        }

        // If the tool call is `inConversation`, we add the tool call to the messages and continue the conversation
        this.messages.push(call);

        const toolResultMessage = new MagmaMessage({
            role: 'assistant',
            content: toolResultBlocks,
        });

        this.messages.push(toolResultMessage);

        return await this.main(config);
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
    public async main(config?: MagmaProviderConfig): Promise<MagmaAssistantMessage> {
        try {
            // Call 'preCompletion' middleware
            if (
                this.messages.at(-1)?.role === 'user' &&
                this.messages.at(-1)?.getToolResults().length === 0
            ) {
                const middlewareErrors = await this.runMiddleware(
                    'preCompletion',
                    this.messages.at(-1)
                );
                if (middlewareErrors.length > 0) {
                    // If the middleware throws an error, return an assistant message with the error to notify the user
                    // remove the user message from the messages array
                    this.messages.pop();
                    return {
                        role: 'assistant',
                        content: middlewareErrors,
                    };
                }
            }

            let message: MagmaMessage;

            const startingProviderConfig = this.providerConfig;

            if (config?.['provider']) {
                this.setProviderConfig(config);
            }

            const provider = Provider.factory(this.providerConfig.provider);

            const completionConfig: MagmaCompletionConfig = {
                providerConfig: this.providerConfig,
                messages: [
                    new MagmaMessage({ role: 'system', content: this.getSystemPrompt() }),
                    ...this.getMessages(this.messageContext),
                ],
                stream: this.stream,
                tools: this.tools,
            };

            // Create a new AbortController for this request
            this.abortController = new AbortController();

            const completion = await provider.makeCompletionRequest(
                completionConfig,
                this.onStreamChunk.bind(this),
                0,
                this.abortController?.signal
            );

            this.setProviderConfig(startingProviderConfig);

            this.onUsageUpdate(completion.usage);

            message = completion.message;

            this.messages.push(message);

            if (message.getToolCalls().length > 0) {
                const toolResultBlocks = await this.executeTools(message);

                this.messages.push(new MagmaMessage({ role: 'user', content: toolResultBlocks }));

                // Trigger another completion because last message was a tool call
                return await this.main(config);
            } else {
                const middlewareErrors = await this.runMiddleware('onCompletion', message);

                if (middlewareErrors.length > 0) {
                    // If the last message is not a user message, remove it to enforce user / assistant alternation
                    if (this.messages.at(-1).role !== 'user') {
                        this.messages.pop();
                    }

                    // Add a system message with all the errors from middleware
                    this.addMessage({
                        role: 'system',
                        content: middlewareErrors,
                    });

                    return await this.main();
                }

                return message as MagmaAssistantMessage;
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                this.logger?.info('Request was aborted');
                throw new Error('Request aborted');
            }
            try {
                this.onError(error);
            } catch {
                throw error;
            }
        } finally {
            this.abortController = null;
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
     */
    public kill(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * Return whether the agent is currently processing a request
     */
    public get processing(): boolean {
        return !!this.abortController;
    }

    public scheduleJobs({ verbose = false }: { verbose?: boolean } = {}): void {
        const jobs = this.jobs;

        for (const job of jobs) {
            if (verbose)
                this.logger?.info(
                    `Job ${job.handler.name.split(' ').at(-1)} scheduled for ${job.schedule}`
                );
            cron.schedule(job.schedule, job.handler.bind(this), job.options);
        }
    }

    /**
     * Given a tool call, find the appropriate function to handle the run
     *
     * @param call MagmaToolCall tool call to run
     * @returns completion to continue the conversation
     */
    private async executeTools(call: MagmaMessage): Promise<MagmaToolResultBlock[]> {
        // run preToolExecution middleware
        const preToolExecutionErrors = (await this.runMiddleware('preToolExecution', call)) ?? [];

        // the calls that threw errors in preToolExecution middleware will be added to the toolResultBlocks
        let toolResultBlocks: MagmaToolResultBlock[] = preToolExecutionErrors;

        // filter out tool calls that throw errors in preToolExecution middleware
        const callsToExecute = call
            .getToolCalls()
            .filter((t) => !preToolExecutionErrors.find((e) => e.tool_result.id === t.id));

        // execute the tool calls that didn't throw errors in preToolExecution middleware
        for (const toolCall of callsToExecute) {
            let toolResult: MagmaToolResult;
            try {
                const tool = this.tools.find((t) => t.name === toolCall.fn_name);
                if (!tool)
                    throw new Error(`No tool found to handle call for ${toolCall.fn_name}()`);

                const result = await tool.target(toolCall, this.state);
                if (!result) {
                    this.logger?.warn(`Tool execution failed for ${toolCall.fn_name}()`);

                    if (this.retryCount >= 3) throw new Error('Tool execution not handled');

                    this.retryCount++;
                }

                toolResult = {
                    id: toolCall.id,
                    result: result,
                    error: false,
                    fn_name: toolCall.fn_name,
                };

                this.retryCount = 0;
            } catch (error) {
                const errorMessage = `Tool Execution Failed for ${toolCall.fn_name}() - ${error.message ?? 'Unknown'}`;
                this.logger?.warn(errorMessage);

                toolResult = {
                    id: toolCall.id,
                    result: errorMessage,
                    error: true,
                    fn_name: toolCall.fn_name,
                };
            } finally {
                toolResultBlocks.push({
                    type: 'tool_result',
                    tool_result: toolResult,
                });
            }
        }

        // run onToolExecution middleware
        const onToolExecutionError =
            (await this.runMiddleware(
                'onToolExecution',
                new MagmaMessage({
                    role: 'assistant',
                    content: toolResultBlocks,
                })
            )) ?? [];

        // replace the results that threw errors in onToolExecution middleware
        toolResultBlocks = toolResultBlocks.map((t) => {
            const error = onToolExecutionError.find((e) => e.tool_result.id === t.tool_result.id);
            if (error) {
                return error;
            }
            return t;
        });

        return toolResultBlocks;
    }

    /**
     * @returns true if there was an error, false otherwise
     */
    private async runMiddleware<T extends MagmaMiddlewareTriggerType>(
        trigger: T,
        message: MagmaMessage
    ): Promise<MagmaMiddlewareReturnType<T>> {
        // Determine whether there are relevant middleware actions to run
        let middleware: MagmaMiddleware[] | null;
        try {
            middleware = this.middleware.filter((f) => f.trigger === trigger);
            if (!middleware || middleware.length === 0) return [] as MagmaMiddlewareReturnType<T>;
        } catch (e) {
            return [] as MagmaMiddlewareReturnType<T>;
        }

        // This array will contain the all error messages from middleware
        const middlewareErrors: MagmaContentBlock[] = [];

        let messagesToProcess: any[] = [message];
        if (message.getToolCalls().length > 0) {
            messagesToProcess = message.getToolCalls();
        } else if (message.getToolResults().length > 0) {
            messagesToProcess = message.getToolResults();
        }

        // Perform each middleware step
        for (const message of messagesToProcess) {
            for (const mdlwr of middleware) {
                try {
                    // Run middleware target action on payload completion
                    await mdlwr.action(message, this.state);
                } catch (error) {
                    const mHash = hash(mdlwr.action.toString());
                    this.middlewareRetries[mHash] ??= 0;
                    this.middlewareRetries[mHash] += 1;

                    if (this.middlewareRetries[mHash] >= kMiddlewareMaxRetries) {
                        this.logger?.error(
                            `${trigger} middleware failed to recover after ${kMiddlewareMaxRetries} attempts`
                        );

                        delete this.middlewareRetries[mHash];
                        continue;
                    }

                    // Add the error to the middlewareErrors array
                    if (trigger === 'preCompletion' || trigger === 'onCompletion') {
                        middlewareErrors.push({
                            type: 'text',
                            text: error.message,
                        });
                    } else if (trigger === 'preToolExecution' || trigger === 'onToolExecution') {
                        // Add the tool result to the middlewareMessage if it threw an error in tool middleware
                        middlewareErrors.push({
                            type: 'tool_result',
                            tool_result: {
                                id: message.id,
                                result: error.message,
                                error: true,
                                fn_name: message.fn_name,
                            },
                        });
                    }

                    this.logger?.warn(
                        `An issue occurred running '${trigger}' middleware - ${error.message ?? 'Unknown'}`
                    );
                }
            }
        }

        if (middlewareErrors.length === 0) {
            // Remove errors for middleware that was just run as everything was OK
            middleware.forEach(
                (mdlwr) => delete this.middlewareRetries[hash(mdlwr.action.toString())]
            );
        }

        return middlewareErrors as MagmaMiddlewareReturnType<T>;
    }

    /* GETTERS */

    public get utilities(): MagmaUtilities[] {
        // Get the utilities from the current instance
        const baseUtilities = [loadUtilities(this)];
        // Get the constructor of the current instance
        const currentConstructor = Object.getPrototypeOf(this).constructor;
        // Get the static utilities from the current class
        const childUtilities = currentConstructor.getUtilities?.() ?? [];

        return [...baseUtilities, ...childUtilities];
    }

    public static getUtilities(): MagmaUtilities[] {
        return [];
    }

    public get tools(): MagmaTool[] {
        return this.utilities.flatMap((u) => u.tools.filter(Boolean));
    }

    public get middleware(): MagmaMiddleware[] {
        return this.utilities.flatMap((u) => u.middleware.filter(Boolean));
    }

    public get hooks(): MagmaHook[] {
        return this.utilities.flatMap((u) => u.hooks.filter(Boolean));
    }

    public get jobs(): MagmaJob[] {
        return this.utilities.flatMap((u) => u.jobs.filter(Boolean));
    }

    /* EVENT HANDLERS */

    getSystemPrompt(): string {
        return '';
    }

    onError(error: Error): Promise<void> {
        throw error;
    }

    onStreamChunk(chunk: MagmaStreamChunk | null): Promise<void> {
        chunk;
        return;
    }

    onUsageUpdate(usage: object): Promise<void> {
        usage;
        return;
    }

    onCleanup(): Promise<void> {
        return;
    }

    onConnect(): Promise<void> {
        return;
    }

    onDisconnect(): Promise<void> {
        return;
    }

    onAudioChunk(chunk: Buffer): Promise<void> {
        chunk;
        return;
    }

    onAudioCommit(): Promise<void> {
        return;
    }

    onAbort(): Promise<void> {
        return;
    }
}
