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
} from './types';
import { Provider } from './providers';
import { MagmaLogger } from './logger';
import { hash, isInstanceOf, loadTools } from './helpers';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const MIDDLEWARE_MAX_RETRIES = 5;

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
    providerConfig?: MagmaProviderConfig;
    fetchSystemPrompts?: () => MagmaSystemMessage[];
    fetchTools?: () => MagmaTool[];
    fetchMiddleware?: () => MagmaMiddleware[];
    onError?: (error: Error) => Promise<void>;
    onUsageUpdate?: (usage: object) => Promise<void>;
    logger?: MagmaLogger;
    messageContext?: number;
};

export default class MagmaAgent {
    private providerConfig: MagmaProviderConfig;
    logger?: MagmaLogger;
    state: State;
    messages: MagmaMessage[];
    retryCount: number;
    middlewareRetries: Record<number, number>;
    messageContext: number;
    defaultTools: MagmaTool[] = [];
    defaultMiddleware: MagmaMiddleware[] = [];
    stream: boolean = false;

    constructor(args?: AgentProps) {
        args ??= {};

        const providerConfig: MagmaProviderConfig = args.providerConfig ?? {
            client: null,
            model: null,
        };

        if (!args.providerConfig) {
            try {
                providerConfig['client'] = new OpenAI();
                providerConfig['model'] = 'gpt-4o';

                if (!providerConfig.client.apiKey)
                    throw new Error('No OpenAI API key found, trying Anthropic');
            } catch (e) {
                try {
                    providerConfig['client'] = new Anthropic();
                    providerConfig['model'] = 'claude-3-5-sonnet-20240620';

                    if (!providerConfig.client.apiKey)
                        throw new Error('No Anthropic API key found');
                } catch (e) {
                    throw new Error('No valid client found');
                }
            }
        }
        this.providerConfig = providerConfig;

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
        if (isInstanceOf(this.providerConfig.client, OpenAI)) return 'openai';
        if (isInstanceOf(this.providerConfig.client, Anthropic)) return 'anthropic';
        return null;
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
     * @param args.returnResult Whether the tool call should be added to the conversation history (default: true)
     * @throws if no tool matching tool is found
     */
    public async trigger(args: {
        name?: string;
        tool?: MagmaTool;
        returnResult?: boolean;
    }): Promise<MagmaAssistantMessage | string> {
        const tool = args.tool ?? this.tools.find((t) => t.name === args.name);

        if (!tool) throw new Error('No tool found to trigger');

        args.returnResult ??= false;

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

        const completion = await provider.makeCompletionRequest(
            completionConfig,
            this.onStreamChunk.bind(this),
        );

        this.onUsageUpdate(completion.usage);

        const call = completion.message as MagmaToolCall;

        await this.runMiddleware('preToolExecution', call);

        // If the tool call is not `returnResult`, we just return the result
        if (args.returnResult) {
            const result = await tool.target(call.fn_args, this.state);

            await this.runMiddleware('onToolExecution', result);

            return result;
        }

        // If the tool call is `returnResult`, we add the tool call to the messages and continue the conversation
        try {
            const result = await tool.target(call.fn_args, this.state);

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
            const provider = Provider.factory(this.providerName);

            // Call 'preCompletion' middleware
            if (this.messages.some((s) => s.role === 'user')) {
                await this.runMiddleware('preCompletion', this.messages.at(-1));
            }

            const tools = this.tools;

            const completionConfig: MagmaConfig = {
                providerConfig: this.providerConfig,
                messages: [...this.fetchSystemPrompts(), ...this.getMessages(this.messageContext)],
                temperature: 0,
                stream: this.stream,
            };

            if (tools.length > 0) completionConfig.tools = tools;

            const completion = await provider.makeCompletionRequest(
                completionConfig,
                this.onStreamChunk.bind(this),
            );

            this.onUsageUpdate(completion.usage);

            const message = completion.message;

            this.messages.push(message);

            if (message.role === 'tool_call') {
                await this.runMiddleware('preToolExecution', message);

                return await this.executeTool(message);
            } else {
                const retry = await this.runMiddleware('onCompletion', message);
                if (retry) {
                    return await this.main();
                }

                return message as MagmaAssistantMessage;
            }
        } catch (error) {
            try {
                this.onError(error);
            } catch {
                throw error;
            }
        }
    }

    /**
     * Set the provider configuration for the agent
     * @param providerConfig provider configuration
     */
    public setProviderConfig(providerConfig: MagmaProviderConfig): void {
        this.providerConfig = providerConfig;
    }

    /**
     * Store a message in the agent context
     *
     * @param content content of the message to store
     * @param role message role (default: user)
     */
    public addMessage(content: string, role: 'system' | 'assistant' | 'user' = 'user'): void {
        this.messages.push({ role, content });
    }

    /* PRIVATE METHODS */

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
    private async executeTool(call: MagmaToolCall) {
        let toolResult: MagmaMessage;
        try {
            const tool = this.tools.find((t) => t.name === call.fn_name);
            if (!tool) throw new Error(`No tool found to handle call for ${call.fn_name}()`);

            const result = await tool.target(call.fn_args, this.state);
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

                if (this.middlewareRetries[mHash] >= MIDDLEWARE_MAX_RETRIES) {
                    this.logger?.error(
                        `${trigger} middleware failed to recover after ${MIDDLEWARE_MAX_RETRIES} attempts`,
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

            this.addMessage(middlewareErrors.join('\n'), 'system');

            return true;
        } else {
            // Remove errors for middleware that was just run as everything was OK
            middleware.forEach(
                (mdlwr) => delete this.middlewareRetries[hash(mdlwr.action.toString())],
            );

            return false;
        }
    }

    private getMessages(slice: number = 20) {
        if (slice === -1) return this.messages;

        let messages = this.messages.slice(-slice);
        if (messages.length && messages.length > 0 && messages.at(0).role === 'tool_result') {
            messages = messages.slice(1);
        }

        return messages;
    }

    private get tools(): MagmaTool[] {
        return [...this.defaultTools, ...this.fetchTools()];
    }

    private get middleware(): MagmaMiddleware[] {
        return [...this.defaultMiddleware, ...this.fetchMiddleware()];
    }
}
