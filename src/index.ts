import {
    MagmaAssistantMessage,
    MagmaConfig,
    MagmaMessage,
    MagmaModel,
    MagmaProvider,
    MagmaSystemMessage,
    MagmaTool,
    MagmaToolCall,
    MagmaToolParam,
    MagmaUsage,
    Middleware,
    MiddlewareTriggerType,
    State,
} from './types';
import { Provider } from './providers';
import { Logger } from './logger';
import { hash } from './helpers';

export type ContextMap = Map<string, any>;

const MIDDLEWARE_MAX_RETRIES = 5;

type AgentProps = {
    provider?: MagmaProvider;
    model?: MagmaModel;
    fetchSystemPrompts?: () => MagmaSystemMessage[];
    fetchTools?: () => MagmaTool[];
    fetchMiddleware?: () => Middleware[];
    onUpdateFunctions?: {
        onError: (error: Error) => void;
        onUsageUpdate?: (usage: object) => void;
    };
    logger?: Logger;
    messageContext?: number;
};

export default class MagmaAgent {
    provider: MagmaProvider;
    model: MagmaModel;
    onUpdateFunctions?: {
        onError: (error: Error) => Promise<void>;
        onUsageUpdate?: (usage: MagmaUsage) => Promise<void>;
    };
    logger?: Logger;
    state: State;
    messages: MagmaMessage[];
    retryCount: number;
    middlewareRetries: Record<number, number>;
    messageContext: number;
    defaultTools: MagmaTool[] = [];
    defaultMiddleware: Middleware[] = [];

    constructor(args?: AgentProps) {
        args ??= {};
        this.provider = args.provider ?? 'openai';
        this.model = args.model ?? 'gpt-4o';
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

        this.logger = args.logger;

        this.state = new Map();
        this.messages = [];
        this.retryCount = 0;
        this.middlewareRetries = {};

        this.loadDefaultTools();
        this.loadDefaultMiddleware();

        this.logger?.debug('Agent initialized');
    }

    fetchTools(): MagmaTool[] {
        return [];
    }

    fetchMiddleware(): Middleware[] {
        return [];
    }

    fetchSystemPrompts(): MagmaSystemMessage[] {
        return [];
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
     * @param toolName The name of the tool to run
     * @throws if no tool matching tool is found
     */
    public async trigger(toolName: string) {
        const tool = this.tools.find((t) => t.name === toolName);

        if (!tool) throw new Error('No tool found to trigger');

        const providerName = this.provider;
        const provider = Provider.factory(providerName);

        const completionConfig: MagmaConfig = {
            model: this.model,
            messages: [...this.fetchSystemPrompts(), ...this.getMessages(this.messageContext)],
            temperature: 0,
            tools: [tool],
            tool_choice: toolName,
        };

        const completion = await provider.makeCompletionRequest(completionConfig);

        const call = completion.message as MagmaToolCall;

        try {
            const result = await tool.target(call.fn_args, this.state);

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
            const providerName = this.provider;
            const provider = Provider.factory(providerName);

            // Call 'preCompletion' middleware
            if (this.messages.some((s) => s.role === 'user')) {
                await this.runMiddleware('preCompletion', this.messages.at(-1));
            }

            const tools = this.tools;

            const completionConfig: MagmaConfig = {
                model: this.model,
                messages: [...this.fetchSystemPrompts(), ...this.getMessages(this.messageContext)],
                temperature: 0,
            };

            if (tools.length > 0) completionConfig.tools = tools;

            const completion = await provider.makeCompletionRequest(completionConfig);

            this.onUpdateFunctions?.onUsageUpdate?.(completion.usage);

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
            if (this.onUpdateFunctions?.onError) {
                this.onUpdateFunctions.onError(error);
            } else {
                throw error;
            }
        }
    }

    /**
     * Set the provider for the agent's completions
     * @param provider openai | anthropic
     */
    public setProvider(provider: Provider): void {
        this.state.set('provider', provider);
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
            const prototype = Object.getPrototypeOf(this);
            const propertyNames = Object.getOwnPropertyNames(prototype);

            const tools: MagmaTool[] = propertyNames
                .map((fxn) => {
                    const method = prototype[fxn];

                    if (!(typeof method === 'function' && '_parameterInfo' in method)) return null;

                    const params = method['_parameterInfo'] as MagmaToolParam[];
                    const toolInfo = method['_toolInfo'];
                    const name = toolInfo?.name ?? method['_methodName'];
                    const description = toolInfo?.description ?? undefined;

                    return {
                        target: method.bind(this),
                        name,
                        description,
                        params,
                    } as MagmaTool;
                })
                .filter((f) => f);

            this.logger?.info(`Loaded ${tools.length} default tools`);

            this.defaultTools = tools ?? [];
        } catch (error) {
            this.logger?.debug(`Failed to load default tools - ${error.message ?? 'Unknown'}`);
        }
    }

    private loadDefaultMiddleware(): void {
        try {
            const prototype = Object.getPrototypeOf(this);
            const propertyNames = Object.getOwnPropertyNames(prototype);

            const middleware: Middleware[] = propertyNames
                .map((fxn) => {
                    const method = prototype[fxn];

                    if (!(typeof method === 'function' && '_middlewareTrigger' in method)) return null;

                    const trigger = method['_middlewareTrigger'] as MiddlewareTriggerType;

                    return {
                        action: method.bind(this),
                        trigger,
                    } as Middleware;
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
        let result: any = null;
        let toolResult: MagmaMessage;
        try {
            for (const tool of this.tools) {
                if (tool.name === call.fn_name) {
                    result = await tool.target(call.fn_args, this.state);

                    this.messages.push({
                        role: 'tool_result',
                        tool_result_id: call.tool_call_id,
                        tool_result: result,
                    });
                    this.retryCount = 0;
                    break;
                }
            }

            if (!result) {
                this.logger?.warn(`No tool found to handle call: ${JSON.stringify(call)}`);

                if (this.retryCount >= 3) throw new Error('Tool execution not handled');

                this.messages.pop();
                this.retryCount++;
            }
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

        // Run 'onToolExecution' middleware
        await this.runMiddleware('onToolExecution', toolResult);

        return await this.main();
    }

    private async runMiddleware(trigger: MiddlewareTriggerType, payload: any): Promise<boolean> {
        // Determine whether there are relevant middleware actions to run
        let middleware: Middleware[] | null;
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

    private get middleware(): Middleware[] {
        return [...this.defaultMiddleware, ...this.fetchMiddleware()];
    }
}
