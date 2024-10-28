import {
    MagmaAssistantMessage,
    MagmaConfig,
    MagmaMessage,
    MagmaProvider,
    MagmaProviderConfig,
    MagmaSystemMessage,
    MagmaTool,
    MagmaToolCall,
    MagmaToolParam,
    MagmaUsage,
    MagmaMiddleware,
    MagmaMiddlewareTriggerType,
    State,
    MagmaStreamChunk,
    MagmaToolResult,
    SocketMessage,
    MagmaFlowConfig,
    TTSClientType,
    MagmaCompletion,
    TTSConfig,
    STTConfig,
} from './types';
import { Provider } from './providers';
import { MagmaLogger } from './logger';
import { EventEmitter } from 'events';
import { hash, loadTools } from './helpers';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import { WebSocket } from 'ws';

const kMiddlewareMaxRetries = 5;
const kMagmaFlowMainTimeout = 15000;
const kMagmaFlowEndpoint = process.env.MODE === 'dev' ? 'magma.ngrok.app' : 'api.magmaflow.dev';

export interface MagmaFlowEvents {
    audio: (chunk: Buffer) => void;
    stream: (chunk: MagmaStreamChunk) => void;
    commit: () => void;
    abort: () => void;
    error: (error: Error) => void;
    connected: () => void;
    disconnected: () => void;
}

/**
 * provider: 'openai' | 'anthropic' (optional)(default openai)
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
    fetchSystemPrompts?: () => MagmaSystemMessage[];
    fetchTools?: () => MagmaTool[];
    fetchMiddleware?: () => MagmaMiddleware[];
    onError?: (error: Error) => Promise<void>;
    onUsageUpdate?: (usage: object) => Promise<void>;
    logger?: MagmaLogger;
    messageContext?: number;
};

export default class MagmaAgent extends EventEmitter {
    agentId?: string;
    logger?: MagmaLogger;
    state: State;
    stream: boolean = false;
    private providerConfig: MagmaProviderConfig;
    private retryCount: number;
    private messages: MagmaMessage[];
    private middlewareRetries: Record<number, number>;
    private messageContext: number;
    private defaultTools: MagmaTool[] = [];
    private defaultMiddleware: MagmaMiddleware[] = [];
    private abortController: AbortController | null = null;
    private ttsConfig: TTSConfig = undefined;
    private sttConfig: STTConfig = undefined;

    // Magma Flow
    private magmaFlowSocket?: WebSocket;
    private apiKey?: string;
    private connected: boolean = false;
    private queue: Promise<void>[] = [];
    // Used to track the number of tools sent to Magma Flow, so we can update the list of tools on the fly
    private lastToolCount: number = 0;
    // Same as above, but for system prompts
    private lastSystemPromptCount: number = 0;

    constructor(args?: AgentProps) {
        // Initialize the EventEmitter
        super();

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

        if (args.fetchSystemPrompts) {
            this.fetchSystemPrompts = args.fetchSystemPrompts;
        }

        if (args.fetchTools) {
            this.fetchTools = args.fetchTools;
        }

        if (args.fetchMiddleware) {
            this.fetchMiddleware = args.fetchMiddleware;
        }

        if (args.onError) {
            this.onError = args.onError;
        }

        if (args.onUsageUpdate) {
            this.onUsageUpdate = args.onUsageUpdate;
        }

        this.agentId = args.agentId;
        this.logger = args.logger;

        this.state = new Map();
        this.messages = [];
        this.retryCount = 0;
        this.middlewareRetries = {};

        this.loadDefaultTools();
        this.loadDefaultMiddleware();

        this.logger?.debug('Agent initialized');
    }

    public get providerName(): MagmaProvider {
        return this.providerConfig.provider;
    }

    fetchTools(): MagmaTool[] {
        return [];
    }

    fetchMiddleware(): MagmaMiddleware[] {
        return [];
    }

    fetchSystemPrompts(): MagmaSystemMessage[] {
        return [];
    }

    onError(error: Error): Promise<void> {
        throw error;
    }

    onStreamChunk(chunk: MagmaStreamChunk): Promise<void> {
        return;
    }

    onUsageUpdate(usage: object): Promise<void> {
        return;
    }

    public async setup(opts?: object): Promise<MagmaAssistantMessage | void> {
        throw new Error('Agent.setup function not implemented');
    }

    public async cleanup(): Promise<void> {
        throw new Error('Agent.cleanup function not implemented');
    }

    /**
     * Method to receive input from the user
     * @param message message object received from the user - type to be defined by extending class
     */
    public async receive(message: any): Promise<void> {
        this.logger?.debug(JSON.stringify(message));
        throw new Error('Agent.receive function not implemented');
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
    }): Promise<MagmaAssistantMessage | string> {
        const tool = args.tool ?? this.tools.find((t) => t.name === args.name);

        if (!tool) throw new Error('No tool found to trigger');

        args.inConversation ??= false;

        const provider = Provider.factory(this.providerName);

        const messages = [...this.fetchSystemPrompts(), ...this.getMessages(this.messageContext)];
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
            this.abortController?.signal,
        );

        this.onUsageUpdate(completion.usage);

        const call = completion.message as MagmaToolCall;

        await this.runMiddleware('preToolExecution', call);

        // If the tool call is not `inConversation`, we just return the result
        if (!args.inConversation) {
            const result = await tool.target(call, this.state);

            await this.runMiddleware('onToolExecution', result);

            return result;
        }

        // If the tool call is `inConversation`, we add the tool call to the messages and continue the conversation
        try {
            this.messages.push(call);

            const result = await tool.target(call, this.state);

            await this.runMiddleware('onToolExecution', result);

            this.messages.push({
                role: 'tool_result',
                tool_result_id: call.tool_call_id,
                tool_result: result,
            });
        } catch (error) {
            const errorMessage = `Tool Execution Failed for ${call.fn_name} - ${error.message ?? 'Unknown'}`;
            this.logger?.warn(errorMessage);
            this.messages.push({
                role: 'tool_result',
                tool_result_id: call.tool_call_id,
                tool_result: errorMessage,
                tool_result_error: true,
            });
        }

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
    public async main(): Promise<MagmaAssistantMessage> {
        try {
            // Call 'preCompletion' middleware
            if (this.messages.some((s) => s.role === 'user')) {
                await this.runMiddleware('preCompletion', this.messages.at(-1));
            }

            let message: MagmaMessage;

            if (this.connected && this.magmaFlowSocket?.readyState === WebSocket.OPEN) {
                const lastMessage = this.messages.at(-1);

                const configUpdates: Partial<MagmaFlowConfig> = {};
                if (this.lastToolCount !== this.tools.length) {
                    this.lastToolCount = this.tools.length;
                    configUpdates.tools = this.tools;
                }

                if (this.lastSystemPromptCount !== this.fetchSystemPrompts().length) {
                    this.lastSystemPromptCount = this.fetchSystemPrompts().length;
                    configUpdates.system_prompts = this.fetchSystemPrompts();
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
                                const data = JSON.parse(message.toString()) as SocketMessage;
                                if (data.type === 'message' && data.data.role === 'assistant') {
                                    cleanup();
                                    resolve(data.data as MagmaMessage);
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
                    providerConfig: this.providerConfig,
                    messages: [
                        ...this.fetchSystemPrompts(),
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
                    this.abortController?.signal,
                );

                this.onUsageUpdate(completion.usage);

                message = completion.message;
            }

            this.messages.push(message);

            if (message.role === 'tool_call') {
                await this.runMiddleware('preToolExecution', message);

                return (await this.executeTool(message)) as MagmaAssistantMessage;
            } else {
                const retry = await this.runMiddleware('onCompletion', message);
                if (retry) {
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
            default:
                throw new Error('Invalid provider');
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
        this.messages.push(message);
    }

    /**
     * Remove a message from the agent context
     * If no filter is provided, the last message is removed
     *
     * @param filter optional filter to remove a specific message
     */
    public removeMessage(filter?: (message: MagmaMessage) => boolean): void {
        if (filter) {
            this.messages = this.messages.filter(filter);
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

    public on<K extends keyof MagmaFlowEvents>(event: K, listener: MagmaFlowEvents[K]): this {
        return super.on(event, listener);
    }

    public emit<K extends keyof MagmaFlowEvents>(
        event: K,
        ...args: Parameters<MagmaFlowEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
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
            `wss://${kMagmaFlowEndpoint}?apiKey=${this.apiKey}&clientType=sdk`,
        );

        this.magmaFlowSocket.on('open', () => {
            this.connected = true;
            this.emit('connected');
            this.logger?.debug('Connected to Magma Flow');

            // Scrape agent to create config
            const config = {
                agent_id: this.agentId,
                tts: this.ttsConfig,
                stt: this.sttConfig,
                provider: this.providerName,
                model: this.providerConfig.model,
                system_prompts: this.fetchSystemPrompts(),
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
            this.emit('disconnected');
            this.magmaFlowSocket = null;

            // If the connection was not closed cleanly, we should try to reconnect
            if (code !== 1000) {
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
            const data = JSON.parse(message.toString()) as SocketMessage;

            switch (data.type) {
                case 'error':
                    this.onError(data.data);
                    break;
                case 'audio.chunk': {
                    const buffer = Buffer.from(data.data, 'base64');
                    this.emit('audio', buffer);
                    break;
                }
                case 'audio.commit':
                    this.emit('commit');
                    break;
                case 'abort':
                    this.emit('abort');
                    break;
                case 'stream.chunk':
                    this.emit('stream', data.data);
                    break;
                case 'usage':
                    this.onUsageUpdate(data.data);
                    break;
                case 'message':
                    if (data.data.role === 'tool_call') {
                        const toolCall = data.data as MagmaToolCall;
                        const result = (await this.executeTool(toolCall)) as string;
                        const toolResult: MagmaToolResult = {
                            role: 'tool_result',
                            tool_result_id: toolCall.tool_call_id,
                            tool_result: result,
                        };
                        this.sendToMagmaFlow({ type: 'message', data: toolResult });
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
    private sendToMagmaFlow(message: SocketMessage): void {
        if (!this.magmaFlowSocket || this.magmaFlowSocket.readyState !== WebSocket.OPEN) return;

        this.magmaFlowSocket.send(JSON.stringify(message));
    }

    private loadDefaultTools(): void {
        try {
            this.defaultTools = loadTools(this);

            this.defaultTools.length > 0 &&
                this.logger?.info(`Loaded ${this.defaultTools.length} default tools`);
        } catch (error) {
            this.logger?.debug(`Failed to load default tools - ${error.message ?? 'Unknown'}`);
        }
    }

    private loadDefaultMiddleware(): void {
        try {
            const prototype = Object.getPrototypeOf(this);
            const propertyNames = Object.getOwnPropertyNames(prototype);

            const middleware: MagmaMiddleware[] = propertyNames
                .map((fxn) => {
                    const method = prototype[fxn];

                    if (!(typeof method === 'function' && '_middlewareTrigger' in method))
                        return null;

                    const trigger = method['_middlewareTrigger'] as MagmaMiddlewareTriggerType;

                    return {
                        action: method.bind(this),
                        trigger,
                    } as MagmaMiddleware;
                })
                .filter((f) => f);

            this.logger?.info(`Loaded ${middleware.length} default middleware`);

            this.defaultMiddleware = middleware ?? [];
        } catch (error) {
            this.logger?.debug(`Failed to load default middleware - ${error.message ?? 'Unknown'}`);
        }
    }

    /**
     * Given a tool call, find the appropriate function to handle the run
     *
     * @param call MagmaToolCall tool call to run
     * @returns completion to continue the conversation
     */
    private async executeTool(call: MagmaToolCall): Promise<MagmaMessage | string> {
        let toolResult: MagmaMessage;
        try {
            const tool = this.tools.find((t) => t.name === call.fn_name);
            if (!tool) throw new Error(`No tool found to handle call for ${call.fn_name}()`);

            const result = await tool.target(call, this.state);
            if (!result) {
                this.logger?.warn(`Tool execution failed for ${call.fn_name}()`);

                if (this.retryCount >= 3) throw new Error('Tool execution not handled');

                this.retryCount++;
            }

            this.messages.push({
                role: 'tool_result',
                tool_result_id: call.tool_call_id,
                tool_result: result,
            });

            // If we're connected to Magma Flow, we can return the result directly which will be passed back to the server
            if (this.connected) {
                return result;
            }

            this.retryCount = 0;
        } catch (error) {
            const errorMessage = `Tool Execution Failed for ${call.fn_name}() - ${error.message ?? 'Unknown'}`;
            this.logger?.warn(errorMessage);
            this.messages.push({
                role: 'tool_result',
                tool_result_id: call.tool_call_id,
                tool_result: errorMessage,
                tool_result_error: true,
            });

            if (this.connected) {
                return errorMessage;
            }
        }

        // Run 'onToolExecution' middleware
        if (toolResult) {
            await this.runMiddleware('onToolExecution', toolResult);
        }

        return await this.main();
    }

    private async runMiddleware(
        trigger: MagmaMiddlewareTriggerType,
        payload: any,
    ): Promise<boolean> {
        // Determine whether there are relevant middleware actions to run
        let middleware: MagmaMiddleware[] | null;
        try {
            middleware = this.middleware.filter((f) => f.trigger === trigger);
            if (!middleware || middleware.length === 0) return false;
        } catch (e) {
            return false;
        }

        const middlewareErrors: string[] = [];

        // Perform each middleware step
        for (const mdlwr of middleware) {
            try {
                // Run middleware target action on payload completion
                const notice = await mdlwr.action(payload, this.state);
                if (notice) {
                    throw new Error(notice);
                }
            } catch (error) {
                const mHash = hash(mdlwr.action.toString());
                this.middlewareRetries[mHash] ??= 0;
                this.middlewareRetries[mHash] += 1;

                if (this.middlewareRetries[mHash] >= kMiddlewareMaxRetries) {
                    this.logger?.error(
                        `${trigger} middleware failed to recover after ${kMiddlewareMaxRetries} attempts`,
                    );

                    delete this.middlewareRetries[mHash];
                    continue;
                }

                middlewareErrors.push(error.message);

                this.logger?.warn(
                    `An issue occurred running '${trigger}' middleware - ${error.message ?? 'Unknown'}`,
                );
            }
        }

        if (middlewareErrors.length > 0) {
            if (this.messages.at(-1).role !== 'user') {
                this.messages.pop();
            }

            this.addMessage({
                role: 'system',
                content: middlewareErrors.join('\n'),
            });

            return true;
        } else {
            // Remove errors for middleware that was just run as everything was OK
            middleware.forEach(
                (mdlwr) => delete this.middlewareRetries[hash(mdlwr.action.toString())],
            );

            return false;
        }
    }

    private get tools(): MagmaTool[] {
        return [...this.defaultTools, ...this.fetchTools()];
    }

    private get middleware(): MagmaMiddleware[] {
        return [...this.defaultMiddleware, ...this.fetchMiddleware()];
    }
}
