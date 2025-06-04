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
} from './types';
import { Provider } from './providers';
import { MagmaLogger } from './logger';
import { hash, loadHooks, loadJobs, loadMiddleware, loadTools } from './helpers';
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
    logger?: MagmaLogger;
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
            client: args.client,
        } as MagmaProviderConfig;

        this.setProviderConfig(providerConfig);

        this.messages = [];
        this.retryCount = 0;
        this.middlewareRetries = {};

        this.scheduledJobs = [];

        this.logger?.debug('Agent initialized');
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
            this.logger?.error(`Error during cleanup: ${error.message ?? 'Unknown'}`);
        } finally {
            this._cleanup();
        }
    }

    private async _cleanup(): Promise<void> {
        this.abortControllers.forEach((controller) => controller.abort());
        this.abortControllers.clear();

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
        config?: MagmaProviderConfig,
        parentRequestIds: string[] = []
    ): Promise<MagmaAssistantMessage | MagmaToolResult> {
        const requestId = Math.random().toString(36).substring(2, 15);
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

                    const completion = await provider.makeCompletionRequest(
                        completionConfig,
                        this.onStreamChunk.bind(this),
                        0,
                        this.abortControllers.get(requestId)?.signal
                    );

                    if (completion === null) {
                        return resolve(null);
                    }

                    this.setProviderConfig(startingProviderConfig);

                    this.onUsageUpdate(completion.usage);

                    const call = completion.message;

                    // If the tool call is not `inConversation`, we just return the result
                    if (!args.addToConversation) {
                        const toolResults = await this.executeTools(call, [tool.name]);
                        return resolve(toolResults[0]);
                    }

                    let modifiedMessage: MagmaMessage;
                    try {
                        modifiedMessage = await this.runMiddleware(
                            'onCompletion',
                            completion.message
                        );
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
                            await this.trigger(args, config, [...parentRequestIds, requestId])
                        );
                    }

                    if (!modifiedMessage) {
                        throw new Error(
                            `Catastrophic error: failed onCompletion middleware ${kMiddlewareMaxRetries} times`
                        );
                    }

                    const toolResults = await this.executeTools(completion.message, [tool.name]);

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
                        return resolve(await this.main(config, [...parentRequestIds, requestId]));
                    }

                    return resolve(modifiedMessage as MagmaAssistantMessage);
                }
            );

            return await triggerPromise;
        } catch (error) {
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
    public async main(
        config?: MagmaProviderConfig,
        parentRequestIds: string[] = []
    ): Promise<MagmaAssistantMessage | null> {
        const requestId = Math.random().toString(36).substring(2, 15);
        for (let i = 0; i < this.messages.length; i++) {
            // if the message is a tool call
            if (
                this.messages[i].role === 'assistant' &&
                this.messages[i].getToolCalls().length > 0
            ) {
                // console.log('Tool call found', this.messages[i]);
                // if the message is at the end of the array, we need to remove it
                if (i === this.messages.length - 1) {
                    // console.log(
                    //     'Tool call found at the end of the array, removing',
                    //     this.messages[i]
                    // );
                    this.messages.pop();
                } else {
                    // if the message is not at the end of the array, make sure the next message is a tool result
                    if (
                        this.messages[i + 1].role === 'user' &&
                        this.messages[i + 1].getToolResults().length > 0
                    ) {
                        // console.log('Tool call found with tool result, continuing');
                        continue;
                    } else {
                        // console.log(
                        //     'Tool call found with no tool result, removing',
                        //     this.messages[i]
                        // );
                        this.messages.splice(i, 1);
                        i--;
                    }
                }
            }
        }

        for (let i = 0; i < this.messages.length; i++) {
            // if the message is a tool result
            if (this.messages[i].role === 'user' && this.messages[i].getToolResults().length > 0) {
                // console.log('Tool result found', this.messages[i]);
                // if the message is at the beginning of the array, we need to remove it
                if (i === 0) {
                    // console.log(
                    //     'Tool result found at the beginning of the array, removing',
                    //     this.messages[i]
                    // );
                    this.messages.shift();
                    i--;
                } else {
                    // if the message is not at the beginning of the array, make sure the previous message is a tool call
                    if (
                        this.messages[i - 1].role === 'assistant' &&
                        this.messages[i - 1].getToolCalls().length > 0
                    ) {
                        // console.log('Tool result found with tool call, continuing');
                        continue;
                    } else {
                        // console.log(
                        //     'Tool result found with no tool call, removing',
                        //     this.messages[i]
                        // );
                        this.messages.splice(i, 1);
                        i--;
                    }
                }
            }
        }

        // console.log(requestId);
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
                    // console.log('Controller for request', requestId, 'aborted and reset');
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
                    middlewareResult = await this.runMiddleware('preCompletion', lastMessage);
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

                const completion = await provider.makeCompletionRequest(
                    completionConfig,
                    this.onStreamChunk.bind(this),
                    0,
                    this.abortControllers.get(requestId)?.signal
                );

                if (completion === null) {
                    // console.log('Completion returned null, returning null for request', requestId);
                    return resolve(null);
                }

                this.setProviderConfig(startingProviderConfig);

                this.onUsageUpdate(completion.usage);

                let modifiedMessage: MagmaMessage;
                try {
                    modifiedMessage = await this.runMiddleware('onCompletion', completion.message);
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

                    return resolve(await this.main(config, [...parentRequestIds, requestId]));
                }

                if (!modifiedMessage) {
                    throw new Error(
                        `Catastrophic error: failed onCompletion middleware ${kMiddlewareMaxRetries} times`
                    );
                }

                const toolResults = await this.executeTools(completion.message);

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
                    return resolve(await this.main(config, [...parentRequestIds, requestId]));
                }

                try {
                    modifiedMessage = await this.runMiddleware('onMainFinish', modifiedMessage);
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

                    return resolve(await this.main(config, [...parentRequestIds, requestId]));
                }

                if (!modifiedMessage) {
                    throw new Error(
                        `Catastrophic error: failed onMainFinish middleware ${kMiddlewareMaxRetries} times`
                    );
                }

                try {
                    modifiedMessage = await this.runMiddleware('postProcess', modifiedMessage);
                } catch (error) {
                    if (this.messages.at(-1).role === 'assistant') {
                        this.messages.pop();
                    }

                    this.addMessage({
                        role: 'system',
                        content: error.message,
                    });

                    // console.log('Error in postProcess middleware, retrying', error);

                    return resolve(await this.main(config, [...parentRequestIds, requestId]));
                }

                // console.log('Main finished, returning message');

                return resolve(modifiedMessage as MagmaAssistantMessage);
            });

            return await mainPromise;
        } catch (error) {
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
                this.logger?.info(
                    `Job ${job.handler.name.split(' ').at(-1)} scheduled for ${job.schedule}`
                );
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
    private async executeTools(
        message: MagmaMessage,
        allowList: string[] = []
    ): Promise<MagmaToolResult[]> {
        // run preToolExecution middleware
        let modifiedMessage = await this.runMiddleware('preToolExecution', message);

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
                        throw new Error(`No tool found to handle call for ${toolCall.fn_name}()`);

                    const result = await tool.target(toolCall, this);
                    if (!result) {
                        this.logger?.warn(`Tool execution failed for ${toolCall.fn_name}()`);
                    }

                    toolResult = {
                        id: toolCall.id,
                        result: result ?? 'No result returned',
                        error: false,
                        fn_name: toolCall.fn_name,
                        call: toolCall,
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
                        call: toolCall,
                    };
                }
            }

            toolResultBlocks.push({
                type: 'tool_result',
                tool_result: toolResult,
            });
        }

        modifiedMessage = await this.runMiddleware(
            'onToolExecution',
            new MagmaMessage({
                role: 'assistant',
                blocks: toolResultBlocks,
            })
        );

        if (!modifiedMessage) {
            throw new Error(
                `Catastrophic error: failed onToolExecution middleware ${kMiddlewareMaxRetries} times`
            );
        }

        return modifiedMessage.getToolResults();
    }

    private async runMiddleware<T extends MagmaMiddlewareTriggerType>(
        trigger: T,
        message: MagmaMessage
    ): Promise<MagmaMessage | null> {
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
                    // Run middleware target action on payload completion
                    const middlewareResult = (await mdlwr.action(
                        middlewarePayload,
                        this
                    )) as MagmaMiddlewareReturnType<T>;
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
                        this.logger?.error(
                            `${trigger} middleware failed to recover after ${kMiddlewareMaxRetries} attempts`
                        );

                        if (mdlwr.critical) {
                            return null;
                        } else {
                            middlewareErrors.pop();
                            delete this.middlewareRetries[mHash];
                            continue;
                        }
                    }

                    this.logger?.warn(
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
