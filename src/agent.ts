import {
    MagmaAssistantMessage,
    MagmaConfig,
    MagmaMessage,
    MagmaProvider,
    MagmaProviderConfig,
    MagmaSystemMessage,
    MagmaTool,
    MagmaToolCallMessage,
    MagmaMiddleware,
    MagmaMiddlewareTriggerType,
    MagmaState,
    MagmaStreamChunk,
    MagmaFlowMessage,
    MagmaFlowConfig,
    TTSConfig,
    STTConfig,
    MagmaToolResultMessage,
    MagmaToolResult,
    MagmaMiddlewareReturnType,
    MagmaUtilities,
    MagmaHook,
    MagmaJob,
} from './types';
import { Provider } from './providers';
import { MagmaLogger } from './logger';
import { hash, loadUtilities } from './helpers';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import { WebSocket } from 'ws';
import cron from 'node-cron';
import { GoogleGenerativeAI } from '@google/generative-ai';
const kMiddlewareMaxRetries = 5;
const kMagmaFlowMainTimeout = 15000;
const kMagmaFlowEndpoint = 'api.magmaflow.dev';

/**
 * provider: 'openai' | 'anthropic' | 'groq' (optional)(default openai)
 * model: any supported model of the associated provider (optional)(default gpt-4o)
 * fetchSystemPrompts: method to retrieve system prompts whenever a completion is generated
 * fetchTools: fetch user-defined tools to make available in context (optional)
 * fetchMiddleware: fetch user-defined middleware actions to perform at various steps in `main()` (optional)
 * onUpdateFunctions: helper functions to receive more granular data throughout the agent main flow (optional)
 * logger: any logger conforming the MagmaLogger type (optional)
 * messageContext: how much conversation history to include in each completion. A value of -1 indicates no limit (optional)(default 20)
 */
type AgentProps = {
    agentId?: string;
    providerConfig?: MagmaProviderConfig;
    apiKey?: string;
    logger?: MagmaLogger;
    messageContext?: number;
};

export class MagmaAgent {
    agentId?: string;
    logger?: MagmaLogger;
    state: MagmaState;
    stream: boolean = false;
    private providerConfig: MagmaProviderConfig;
    private retryCount: number;
    private messages: MagmaMessage[];
    private middlewareRetries: Record<number, number>;
    private messageContext: number;
    private abortController: AbortController | null = null;
    private ttsConfig: TTSConfig = undefined;
    private sttConfig: STTConfig = undefined;

    // Magma Flow
    private magmaFlowSocket?: WebSocket;
    private apiKey?: string;
    private connected: boolean = false;
    private queue: Promise<void>[] = [];
    // Used to track the number of tools sent to Magma Flow, so we can update the list of tools on the fly
    private lastToolHash: number = 0;
    // Same as above, but for system prompts
    private lastSystemPromptHash: number = 0;

    constructor(args?: AgentProps) {
        args ??= {};

        if (args.apiKey && args.apiKey.startsWith('mf_')) {
            this.apiKey = args.apiKey;
            this.connectToMagmaFlow();
        }

        // Set the provider config
        // Even if we're using Magma Flow, we still need a provider config to send in config
        const providerConfig: MagmaProviderConfig = args.providerConfig ?? {
            provider: 'openai',
            model: 'gpt-4o',
        };

        this.setProviderConfig(providerConfig);

        this.messageContext = args?.messageContext ?? 20;

        this.agentId = args.agentId;
        this.logger = args.logger;

        this.state = new Map();
        this.messages = [];
        this.retryCount = 0;
        this.middlewareRetries = {};

        this.logger?.debug('Agent initialized');
    }

    public get providerName(): MagmaProvider {
        return this.providerConfig.provider;
    }

    public async setup?(opts?: object): Promise<MagmaAssistantMessage | void> {}

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
        this.lastToolHash = 0;
        this.lastSystemPromptHash = 0;
        this.abortController = null;

        // Disconnect from MagmaFlow and event emitters
        if (this.magmaFlowSocket?.readyState === WebSocket.OPEN) {
            this.magmaFlowSocket?.close(1000, 'Agent cleanup');
        }

        this.messages = [];

        this.logger?.debug('Agent cleanup complete');
    }

    /**
     * Manually trigger a tool call in the context of the conversation
     *
     * @param args.name The name of the tool to run
     * @param args.tool The Magma tool to run
     * Either `name` or `tool` must be provided. Tool will be prioritized if both are provided.
     * @param args.inConversation Whether the tool call should be added to the conversation history (default: false)
     * @throws if no tool matching tool is found
     */
    public async trigger(args: {
        name?: string;
        tool?: MagmaTool;
        inConversation?: boolean;
    }): Promise<MagmaAssistantMessage | MagmaToolResult> {
        const tool = args.tool ?? this.tools.find((t) => t.name === args.name);

        if (!tool) throw new Error('No tool found to trigger');

        args.inConversation ??= false;

        const provider = Provider.factory(this.providerName);

        const messages = [...this.getSystemPrompts(), ...this.getMessages(this.messageContext)];
        if (messages.length > 0 && messages.at(-1).role === 'tool_call') {
            messages.pop();
        }

        const completionConfig: MagmaConfig = {
            providerConfig: this.providerConfig,
            messages,
            temperature: 0,
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

        this.onUsageUpdate(completion.usage);

        const call = completion.message as MagmaToolCallMessage;

        let middlewareError = await this.runMiddleware('preToolExecution', call);

        // If the tool call is not `inConversation`, we just return the result
        if (!args.inConversation) {
            if (middlewareError) {
                return middlewareError.tool_results[0];
            }

            const result = await this.executeTools(call);

            middlewareError = await this.runMiddleware('onToolExecution', result);

            if (middlewareError) {
                return middlewareError.tool_results[0];
            }

            return result.tool_results[0];
        }

        // If the tool call is `inConversation`, we add the tool call to the messages and continue the conversation
        this.messages.push(call);

        // This array will identify tool calls that throw errors in tool middleware
        let rejectedToolCallIds: string[] = [];

        // If there are errors in preToolExecution middleware, add the tool call ids to the rejectedToolCallIds array
        if (middlewareError) {
            rejectedToolCallIds.push(...middlewareError.tool_results.map((r) => r.id));
        }

        // Filter out the tool calls that threw errors in tool middleware
        const toolCallMessage: MagmaToolCallMessage = {
            ...call,
            tool_calls: call.tool_calls.filter((t) => !rejectedToolCallIds.includes(t.id)),
        };

        // Execute the tool calls that didn't throw errors in tool middleware
        const toolResultMessage = await this.executeTools(toolCallMessage);

        // Recombine with the tool results that threw errors in tool middleware, if any
        if (middlewareError) {
            toolResultMessage.tool_results.push(...middlewareError.tool_results);
        }

        // Reset the rejectedToolCallIds array
        rejectedToolCallIds = [];

        // Run the 'onToolExecution' middleware
        middlewareError = await this.runMiddleware('onToolExecution', toolResultMessage);

        // If there are errors in onToolExecution middleware, add the tool call ids to the rejectedToolCallIds array
        if (middlewareError) {
            rejectedToolCallIds.push(...middlewareError.tool_results.map((r) => r.id));

            // Filter out the tool calls that threw errors in onToolExecution middleware
            toolResultMessage.tool_results = toolResultMessage.tool_results.filter(
                (t) => !rejectedToolCallIds.includes(t.id)
            );

            // Recombine with the tool results that threw errors in onToolExecution middleware, if any
            toolResultMessage.tool_results.push(...middlewareError.tool_results);
        }

        this.messages.push(toolResultMessage);

        return await this.main();
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
    public async main(config?: MagmaConfig): Promise<MagmaAssistantMessage> {
        try {
            // Call 'preCompletion' middleware
            if (this.messages.at(-1)?.role === 'user') {
                const middlewareError = await this.runMiddleware(
                    'preCompletion',
                    this.messages.at(-1)
                );
                if (middlewareError) {
                    // If the middleware throws an error, return an assistant message with the error to notify the user
                    // remove the user message from the messages array
                    this.messages.pop();
                    return {
                        role: 'assistant',
                        content: middlewareError,
                    };
                }
            }

            let message: MagmaMessage;

            if (this.connected && this.magmaFlowSocket?.readyState === WebSocket.OPEN) {
                const lastMessage = this.messages.at(-1);

                const configUpdates: Partial<MagmaFlowConfig> = {};
                if (this.lastToolHash !== hash(JSON.stringify(this.tools))) {
                    this.lastToolHash = hash(JSON.stringify(this.tools));
                    configUpdates.tools = this.tools;
                }

                if (this.lastSystemPromptHash !== hash(JSON.stringify(this.getSystemPrompts()))) {
                    this.lastSystemPromptHash = hash(JSON.stringify(this.getSystemPrompts()));
                    configUpdates.system_prompts = this.getSystemPrompts();
                }

                if (Object.keys(configUpdates).length > 0) {
                    this.sendToMagmaFlow({ type: 'config', data: configUpdates });
                }

                try {
                    this.sendToMagmaFlow({ type: 'message', data: lastMessage });

                    // Construct a promise that will resolve when a message is received from Magma Flow
                    // Times out after kMagmaFlowMainTimeout milliseconds
                    const serverAgentPromise = new Promise<MagmaMessage>((resolve, reject) => {
                        // Set timeout to reject promise
                        const timeout = setTimeout(() => {
                            cleanup();
                            reject(new Error('Timeout waiting for agent reply'));
                        }, kMagmaFlowMainTimeout);

                        // Handle incoming messages from Magma Flow
                        const messageHandler = (message: MessageEvent) => {
                            try {
                                const data = JSON.parse(message.toString()) as MagmaFlowMessage;
                                if (data.type === 'message' && data.data.role === 'assistant') {
                                    cleanup();
                                    resolve(data.data);
                                }
                            } catch (error) {
                                cleanup();
                                reject(error);
                            }
                        };

                        // Cleanup function to clear the timeout and remove the message handler
                        const cleanup = () => {
                            clearTimeout(timeout);
                            this.magmaFlowSocket?.removeListener('message', messageHandler);
                        };

                        // Add the message handler
                        this.magmaFlowSocket.on('message', messageHandler);
                    });

                    message = await serverAgentPromise;
                } catch (error) {
                    await this.onError(error);
                    throw error;
                }
            } else {
                const provider = Provider.factory(this.providerName);

                const tools = this.tools;

                const completionConfig: MagmaConfig = {
                    ...config,
                    providerConfig: this.providerConfig,
                    messages: [
                        ...this.getSystemPrompts(),
                        ...this.getMessages(this.messageContext),
                    ],
                    temperature: 0,
                    stream: this.stream,
                };

                if (tools.length > 0) completionConfig.tools = tools;

                // Create a new AbortController for this request
                this.abortController = new AbortController();

                const completion = await provider.makeCompletionRequest(
                    completionConfig,
                    this.onStreamChunk.bind(this),
                    0,
                    this.abortController?.signal
                );

                this.onUsageUpdate(completion.usage);

                message = completion.message;

                this.messages.push(message);
            }

            if (message.role === 'tool_call') {
                // This array will identify tool calls that throw errors in preToolExecution middleware
                let rejectedToolCallIds: string[] = [];

                // Run the 'preToolExecution' middleware
                let middlewareError = await this.runMiddleware('preToolExecution', message);

                if (middlewareError) {
                    // some tool calls threw errors in preToolExecution middleware, add their ids to the rejectedToolCallIds array
                    rejectedToolCallIds = middlewareError.tool_results.map((r) => r.id);
                }

                // Filter out the tool calls that threw errors in preToolExecution middleware
                const toolCallMessage: MagmaToolCallMessage = {
                    ...message,
                    tool_calls: message.tool_calls.filter(
                        (t) => !rejectedToolCallIds.includes(t.id)
                    ),
                };

                // Execute the tool calls that didn't throw errors in preToolExecution middleware
                const toolResultMessage = await this.executeTools(toolCallMessage);

                if (middlewareError) {
                    // Recombine with the tool results that threw errors in preToolExecution middleware, if any
                    toolResultMessage.tool_results.push(...middlewareError.tool_results);
                }

                // Run the 'onToolExecution' middleware
                middlewareError = await this.runMiddleware('onToolExecution', toolResultMessage);

                if (middlewareError) {
                    // some tool calls threw errors in onToolExecution middleware, add their ids to the rejectedToolCallIds array
                    rejectedToolCallIds = middlewareError.tool_results.map((r) => r.id);

                    // Filter out the tool calls that threw errors in onToolExecution middleware
                    toolResultMessage.tool_results = toolResultMessage.tool_results.filter(
                        (t) => !rejectedToolCallIds.includes(t.id)
                    );

                    // Recombine with the tool results that threw errors in onToolExecution middleware, if any
                    if (middlewareError) {
                        toolResultMessage.tool_results.push(...middlewareError.tool_results);
                    }
                }

                // Add the combined tool results to the messages array
                this.messages.push(toolResultMessage);

                // Trigger another completion because last message was a tool call
                return await this.main();
            } else {
                const middlewareError = await this.runMiddleware('onCompletion', message);

                if (middlewareError) {
                    // If the last message is not a user message, remove it to enforce user / assistant alternation
                    if (this.messages.at(-1).role !== 'user') {
                        this.messages.pop();
                    }

                    // Add a system message with all the errors from middleware
                    this.addMessage({
                        role: 'system',
                        content: middlewareError,
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
     * Set the TTS (Text-to-Speech) configuration for the agent
     * @param ttsConfig TTS configuration
     */
    public setTTSConfig(ttsConfig: Partial<TTSConfig>): void {
        this.ttsConfig = { ...this.ttsConfig, ...ttsConfig };
    }

    /**
     * Set the STT (Speech-to-Text) configuration for the agent
     * @param sttConfig STT configuration
     */
    public setSTTConfig(sttConfig: Partial<STTConfig>): void {
        this.sttConfig = { ...this.sttConfig, ...sttConfig };
    }

    /**
     * Store a message in the agent context
     *
     * @param content content of the message to store
     * @param role message role (default: user)
     */
    public addMessage(message: MagmaMessage): void {
        if ('images' in message) {
            // Validate images are base64 data, not URLs
            for (const image of message.images ?? []) {
                if (
                    (this.providerName === 'anthropic' || this.providerName === 'google') &&
                    typeof image === 'string'
                ) {
                    if (image.startsWith('http')) {
                        throw new Error('Image URLs are not supported by Anthropic');
                    }
                }
            }
        }

        this.messages.push(message);
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
        if (messages.length && messages.length > 0 && messages.at(0).role === 'tool_result') {
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

    public abort(): void {
        this.sendToMagmaFlow({ type: 'abort', data: null });
    }

    public commit(): void {
        this.sendToMagmaFlow({ type: 'audio.commit', data: null });
    }

    /**
     * Send an audio chunk to Magma Flow
     * @param chunk audio chunk to send (either a Buffer or a base64 encoded string)
     */
    public audio(chunk: Buffer | string): void {
        const data = typeof chunk === 'string' ? chunk : chunk.toString('base64');
        this.sendToMagmaFlow({ type: 'audio.chunk', data });
    }

    /**
     * Return whether the agent is currently processing a request
     */
    public get processing(): boolean {
        return !!this.abortController;
    }

    /* PRIVATE METHODS */

    /**
     * Connect to Magma Flow
     */
    private connectToMagmaFlow(): void {
        if (this.magmaFlowSocket?.readyState === WebSocket.OPEN || !this.apiKey) return;

        this.magmaFlowSocket = new WebSocket(
            `wss://${kMagmaFlowEndpoint}?apiKey=${this.apiKey}&clientType=sdk`
        );

        this.magmaFlowSocket.on('open', () => {
            this.connected = true;
            this.onConnect();
            this.logger?.debug('Connected to Magma Flow');

            // Scrape agent to create config
            const config = {
                agent_id: this.agentId,
                tts: this.ttsConfig,
                stt: this.sttConfig,
                provider: this.providerName,
                model: this.providerConfig.model,
                system_prompts: this.getSystemPrompts(),
                tools: this.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    params: t.params,
                })),
            } as MagmaFlowConfig;

            this.sendToMagmaFlow({ type: 'config', data: config });
        });

        this.magmaFlowSocket.on('error', (error) => {
            this.logger?.error(`Magma Flow Error - ${error?.message ?? 'Unknown'}`);
            this.onError(error);
        });

        this.magmaFlowSocket.on('close', (code) => {
            this.connected = false;
            this.logger?.debug('Disconnected from Magma Flow');
            this.onDisconnect();

            // If the connection was not closed cleanly, we should try to reconnect
            if (code === 1000) {
                this.magmaFlowSocket = null;
            } else {
                setTimeout(() => {
                    this.connectToMagmaFlow();
                }, 1000);
            }
        });

        this.magmaFlowSocket.on('message', this.handleMagmaFlowMessage.bind(this));
    }

    /**
     * Handle a message from Magma Flow
     * @param message message from Magma Flow
     */
    private async handleMagmaFlowMessage(message: MessageEvent): Promise<void> {
        try {
            const data = JSON.parse(message.toString()) as MagmaFlowMessage;

            switch (data.type) {
                case 'error':
                    this.onError(data.data);
                    break;
                case 'audio.chunk': {
                    const buffer = Buffer.from(data.data, 'base64');
                    this.onAudioChunk(buffer);
                    break;
                }
                case 'audio.commit':
                    this.onAudioCommit();
                    break;
                case 'abort':
                    this.onAbort();
                    break;
                case 'stream.chunk':
                    this.onStreamChunk(data.data);
                    break;
                case 'usage':
                    this.onUsageUpdate(data.data);
                    break;
                case 'message':
                    if (data.data.role === 'tool_call') {
                        const toolCallMessage = data.data as MagmaToolCallMessage;
                        const toolResultMessage = await this.executeTools(toolCallMessage);

                        this.sendToMagmaFlow({ type: 'message', data: toolResultMessage });
                    } else {
                        // Used to make sure local context is in sync with Magma Flow's agent
                        this.addMessage(data.data as MagmaMessage);
                    }
                    break;
                default:
                    break;
            }
        } catch (error) {
            this.logger?.error(`Magma Flow Message Error - ${error?.message ?? 'Unknown'}`);
            this.onError(error);
        }
    }

    /**
     * Send a message to Magma Flow
     * @param message message to send
     */
    private sendToMagmaFlow(message: MagmaFlowMessage): void {
        if (!this.magmaFlowSocket || this.magmaFlowSocket.readyState !== WebSocket.OPEN) return;

        this.magmaFlowSocket.send(JSON.stringify(message));
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
    private async executeTools(call: MagmaToolCallMessage): Promise<MagmaToolResultMessage> {
        let toolResultMessage: MagmaToolResultMessage = {
            role: 'tool_result',
            tool_results: [],
        };
        for (const toolCall of call.tool_calls) {
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

                if (typeof result !== 'string') {
                    throw new Error(
                        `Tool ${toolCall.fn_name}() did not return a string, instead returned ${typeof result}`
                    );
                }

                // If we're connected to Magma Flow, we can return the result directly which will be passed back to the server
                // if (this.connected) {
                //     return result;
                // }

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

                // if (this.connected) {
                //     return errorMessage;
                // }
            } finally {
                toolResultMessage.tool_results.push(toolResult);
            }
        }

        return toolResultMessage;
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
            if (!middleware || middleware.length === 0) return null;
        } catch (e) {
            return null;
        }

        // The string array will contain the all error messages from middleware
        const middlewareErrors: string[] = [];
        // The tool result message will contain the tool results that threw errors in tool middleware
        let middlewareMessage: MagmaToolResultMessage = {
            role: 'tool_result',
            tool_results: [],
        };

        let messagesToProcess: any[] = [message];
        if (message.role === 'tool_call') {
            messagesToProcess = message.tool_calls;
        } else if (message.role === 'tool_result') {
            messagesToProcess = message.tool_results;
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
                    middlewareErrors.push(error.message);
                    if (trigger === 'preToolExecution' || trigger === 'onToolExecution') {
                        // Add the tool result to the middlewareMessage if it threw an error in tool middleware
                        middlewareMessage.tool_results.push({
                            id: message.id,
                            result: error.message,
                            error: true,
                            fn_name: message.fn_name,
                        });
                    }

                    this.logger?.warn(
                        `An issue occurred running '${trigger}' middleware - ${error.message ?? 'Unknown'}`
                    );
                }
            }
        }

        if (middlewareErrors.length > 0) {
            switch (trigger) {
                case 'preCompletion':
                case 'onCompletion':
                    // Return the errors so we can handle conversation flow
                    return middlewareErrors.join('\n') as MagmaMiddlewareReturnType<T>;
                case 'preToolExecution':
                case 'onToolExecution':
                    // Return the tool result message to the user
                    return middlewareMessage as MagmaMiddlewareReturnType<T>;
            }
        } else {
            // Remove errors for middleware that was just run as everything was OK
            middleware.forEach(
                (mdlwr) => delete this.middlewareRetries[hash(mdlwr.action.toString())]
            );

            return null;
        }
    }

    /* GETTERS */

    public get utilities(): MagmaUtilities[] {
        const baseUtilities = [loadUtilities(this)];
        // Get the constructor of the current instance
        const currentConstructor = Object.getPrototypeOf(this).constructor;
        // Get utilities from the current class
        const childUtilities = currentConstructor.getUtilities();

        return [...baseUtilities, ...childUtilities];
    }

    public static getUtilities(): MagmaUtilities[] {
        return [];
    }

    private get tools(): MagmaTool[] {
        return this.utilities.flatMap((u) => u.tools);
    }

    private get middleware(): MagmaMiddleware[] {
        return this.utilities.flatMap((u) => u.middleware);
    }

    private get hooks(): MagmaHook[] {
        return this.utilities.flatMap((u) => u.hooks);
    }

    private get jobs(): MagmaJob[] {
        return this.utilities.flatMap((u) => u.jobs);
    }

    /* EVENT HANDLERS */

    getSystemPrompts(): MagmaSystemMessage[] {
        return [];
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
