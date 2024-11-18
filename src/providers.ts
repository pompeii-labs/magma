import {
    ChatCompletionMessageParam as OpenAIMessageParam,
    ChatCompletionTool as OpenAITool,
} from 'openai/resources/index.mjs';
import { mapNumberInRange, sleep } from './helpers.js';
import { Logger } from './logger.js';
import {
    MagmaTool,
    MagmaConfig,
    MagmaMessage,
    MagmaCompletion,
    MagmaProvider,
    MagmaToolParam,
    MagmaStreamChunk,
    MagmaUsage,
} from './types/index.js';
import {
    MessageCreateParamsBase as AnthropicConfig,
    MessageParam as AnthropicMessageParam,
    Tool as AnthropicTool,
    Message as AnthropicMessage,
} from '@anthropic-ai/sdk/resources/messages.mjs';
import { cleanParam } from './helpers.js';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
    ChatCompletion,
    ChatCompletionCreateParamsBase,
} from 'openai/resources/chat/completions.mjs';
import {
    ChatCompletionTool as GroqTool,
    ChatCompletionMessageParam as GroqMessageParam,
    ChatCompletionCreateParamsBase as GroqConfig,
} from 'groq-sdk/resources/chat/completions.mjs';
import Groq from 'groq-sdk';

dotenv.config();

const MAX_RETRIES = 5;

interface ProviderProps {
    name: MagmaProvider;
}

export abstract class Provider implements ProviderProps {
    name: MagmaProvider;

    constructor(props: ProviderProps) {
        this.name = props.name;
    }

    public static factory(name: MagmaProvider): typeof Provider {
        switch (name) {
            case 'anthropic':
                return AnthropicProvider;
            case 'openai':
                return OpenAIProvider;
            case 'groq':
                return GroqProvider;
            default:
                throw new Error(`Can not create factory class Provider with type ${name}`);
        }
    }

    static convertMessages(messages: MagmaMessage[]): object[] {
        messages;
        throw new Error('Provider.convertMessages not implemented');
    }

    static async makeCompletionRequest(
        config: MagmaConfig,
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
        attempt: number = 0,
        signal?: AbortSignal,
    ): Promise<MagmaCompletion> {
        config;
        onStreamChunk;
        attempt;
        signal;
        throw new Error('Provider.makeCompletionRequest not implemented');
    }

    static convertTools(tools: MagmaTool[]): object[] {
        tools;
        throw new Error('Provider.convertTools not implemented');
    }

    static convertConfig(config: MagmaConfig): object {
        config;
        throw new Error('Provider.convertConfig not implemented');
    }
}

export class AnthropicProvider extends Provider {
    static override convertConfig(config: MagmaConfig): AnthropicConfig {
        const tools: AnthropicTool[] | undefined = config.tools
            ? this.convertTools(config.tools)
            : undefined;

        let tool_choice = undefined;

        if (config.tool_choice === 'auto') tool_choice = { type: 'auto' };
        else if (config.tool_choice === 'required') tool_choice = { type: 'any' };
        else if (typeof config.tool_choice === 'string')
            tool_choice = { type: 'tool', name: config.tool_choice };

        const model = config.providerConfig.model;

        delete config.providerConfig;

        const anthropicConfig: AnthropicConfig = {
            ...config,
            model,
            messages: this.convertMessages(config.messages),
            max_tokens: 2048,
            tools: tools,
            tool_choice: tool_choice,
            system: config.messages
                .filter((m) => m.role === 'system')
                .map((m) => m.content)
                .join('\n'),
        };

        return anthropicConfig;
    }

    static override convertMessages(messages: MagmaMessage[]): AnthropicMessageParam[] {
        const anthropicMessages: AnthropicMessageParam[] = [];

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if ('id' in message) delete message.id;

            switch (message.role) {
                case 'system':
                    continue;

                case 'assistant':
                    anthropicMessages.push({
                        role: 'assistant',
                        content: message.content,
                    });

                    // Check if the next message is also from the assistant
                    if (i + 1 < messages.length && messages[i + 1].role === 'assistant') {
                        anthropicMessages.push({
                            role: 'user',
                            content: 'Continue.',
                        });
                    }
                    break;

                case 'user':
                    anthropicMessages.push({
                        role: 'user',
                        content: message.content,
                    });
                    break;

                case 'tool_call':
                    anthropicMessages.push({
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: message.tool_call_id,
                                name: message.fn_name,
                                input: message.fn_args,
                            },
                        ],
                    });
                    break;

                case 'tool_result':
                    anthropicMessages.push({
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: message.tool_result_id,
                                content: message.tool_result,
                                is_error: message.tool_result_error,
                            },
                        ],
                    });
                    break;
            }
        }

        if (anthropicMessages.length === 0 || anthropicMessages.at(0).role != 'user')
            anthropicMessages.unshift({
                role: 'user',
                content: 'begin',
            });

        // if (anthropicMessages.at(-1).role != 'user')
        //     anthropicMessages.push({
        //         role: 'user',
        //         content: 'Continue in the natural flow of the conversation with the user',
        //     });

        return anthropicMessages;
    }

    static override async makeCompletionRequest(
        config: MagmaConfig,
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
        attempt: number = 0,
        signal?: AbortSignal,
    ): Promise<MagmaCompletion> {
        try {
            const anthropic = config.providerConfig.client as Anthropic;
            if (!anthropic) throw new Error('Anthropic instance not configured');

            const anthropicConfig = this.convertConfig(config);

            if (config.stream) {
                const stream = await anthropic.messages.create(
                    {
                        ...anthropicConfig,
                        stream: true,
                    },
                    { signal },
                );

                let buffer = '';
                const usage: {
                    input_tokens: number;
                    output_tokens: number;
                } = {
                    input_tokens: 0,
                    output_tokens: 0,
                };

                const streamedToolCalls: {
                    id: string;
                    name: string;
                    argumentsBuffer: string;
                    arguments: Record<string, any>;
                }[] = [];

                for await (const chunk of stream) {
                    let magmaStreamChunk: MagmaStreamChunk;

                    switch (chunk.type) {
                        case 'message_start':
                            usage.input_tokens += chunk.message.usage.input_tokens;
                            usage.output_tokens += chunk.message.usage.output_tokens;
                            break;
                        case 'message_delta':
                            usage.output_tokens += chunk.usage.output_tokens;
                            break;
                        case 'content_block_delta':
                            if (chunk.delta.type === 'text_delta') {
                                buffer += chunk.delta.text;
                                magmaStreamChunk = {
                                    provider: 'anthropic',
                                    model: anthropicConfig.model,
                                    delta: {
                                        content: chunk.delta.text,
                                    },
                                    buffer: buffer,
                                };
                            } else if (chunk.delta.type === 'input_json_delta') {
                                streamedToolCalls[0].argumentsBuffer += chunk.delta.partial_json;
                            }
                            break;
                        case 'content_block_start':
                            if (chunk.content_block.type === 'tool_use') {
                                streamedToolCalls.push({
                                    id: chunk.content_block.id,
                                    name: chunk.content_block.name,
                                    argumentsBuffer: '',
                                    arguments: {},
                                });
                            }
                            break;
                        case 'message_stop': {
                            let magmaMessage: MagmaMessage;

                            if (streamedToolCalls.length > 0) {
                                const toolCall = streamedToolCalls[0];
                                toolCall.arguments = JSON.parse(toolCall.argumentsBuffer);
                                magmaMessage = {
                                    role: 'tool_call',
                                    tool_call_id: toolCall.id,
                                    fn_name: toolCall.name,
                                    fn_args: toolCall.arguments,
                                };
                            } else {
                                magmaMessage = { role: 'assistant', content: buffer };
                                onStreamChunk();
                            }

                            const magmaCompletion: MagmaCompletion = {
                                provider: 'anthropic',
                                model: anthropicConfig.model,
                                message: magmaMessage,
                                usage: usage,
                            };

                            return magmaCompletion;
                        }
                    }

                    if (onStreamChunk && magmaStreamChunk) {
                        onStreamChunk(magmaStreamChunk);
                    }
                }
            } else {
                const anthropicCompletion = (await anthropic.messages.create(anthropicConfig, {
                    signal,
                })) as AnthropicMessage;

                const toolCall = anthropicCompletion.content.find((c) => c.type === 'tool_use');
                const anthropicMessage = toolCall ?? anthropicCompletion.content[0];
                let magmaMessage: MagmaMessage;
                if (!anthropicMessage) {
                    throw new Error('Anthropic completion was null');
                }

                if (anthropicMessage.type === 'tool_use')
                    magmaMessage = {
                        role: 'tool_call',
                        tool_call_id: anthropicMessage.id,
                        fn_name: anthropicMessage.name,
                        fn_args: anthropicMessage.input,
                    };
                else if (anthropicMessage.type === 'text')
                    magmaMessage = { role: 'assistant', content: anthropicMessage.text };

                const magmaCompletion: MagmaCompletion = {
                    provider: 'anthropic',
                    model: anthropicCompletion.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: anthropicCompletion.usage.input_tokens,
                        output_tokens: anthropicCompletion.usage.output_tokens,
                    },
                };

                return magmaCompletion;
            }
        } catch (error) {
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }
            if (error.error?.type === 'rate_limit_error') {
                if (attempt >= MAX_RETRIES) {
                    throw new Error(`Rate limited after ${MAX_RETRIES} attempts`);
                }
                const delay = Math.min(Math.pow(2, attempt) * 1000, 60000);
                Logger.main.warn(`Rate limited. Retrying after ${delay}ms.`);

                await sleep(delay);
                return this.makeCompletionRequest(config, onStreamChunk, attempt + 1);
            } else {
                throw error;
            }
        }
    }

    // Tool schema to LLM function call converter
    static override convertTools(tools: MagmaTool[]): AnthropicTool[] {
        const anthropicTools: AnthropicTool[] = [];
        for (const tool of tools) {
            const baseObject: MagmaToolParam = {
                type: 'object',
                properties: tool.params,
            };

            anthropicTools.push({
                name: tool.name,
                description: tool.description,
                input_schema: (tool.params.length === 0
                    ? { type: 'object' }
                    : cleanParam(baseObject, [])) as AnthropicTool.InputSchema,
            });
        }

        return anthropicTools;
    }
}

export class OpenAIProvider extends Provider {
    static override async makeCompletionRequest(
        config: MagmaConfig,
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
        attempt: number = 0,
        signal?: AbortSignal,
    ): Promise<MagmaCompletion> {
        try {
            const openai = config.providerConfig.client as OpenAI;
            if (!openai) throw new Error('OpenAI instance not configured');

            const openAIConfig = this.convertConfig(config);

            if (config.stream) {
                const stream = await openai.chat.completions.create(
                    {
                        ...openAIConfig,
                        stream: true,
                        stream_options: { include_usage: true },
                    },
                    { signal },
                );

                let buffer = '';
                const usage: MagmaUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                };

                const streamedToolCalls: {
                    id: string;
                    name: string;
                    argumentsBuffer: string;
                    arguments: Record<string, any>;
                }[] = [];

                for await (const chunk of stream) {
                    const delta = chunk?.choices[0]?.delta;

                    // First stream chunk telling us what tools are being called
                    if (delta?.tool_calls?.length > 0 && streamedToolCalls.length === 0) {
                        for (const toolCall of delta.tool_calls) {
                            streamedToolCalls.push({
                                id: toolCall.id,
                                name: toolCall.function.name,
                                argumentsBuffer: toolCall.function.arguments,
                                arguments: {},
                            });
                        }
                    } else if (delta?.tool_calls?.length > 0) {
                        // Subsequent stream chunks with tool call results buffering up
                        for (const toolCall of delta.tool_calls) {
                            streamedToolCalls[toolCall.index].argumentsBuffer +=
                                toolCall.function.arguments;
                        }
                    }

                    if (chunk.usage) {
                        usage.input_tokens = chunk.usage?.prompt_tokens ?? 0;
                        usage.output_tokens = chunk.usage?.completion_tokens ?? 0;
                        continue;
                    }

                    if (streamedToolCalls.length > 0) {
                        // We are still waiting for tool call results to come in
                        // We do NOT want to buffer the delta here, as it will be conflated as completion text
                        // and might go into a tts client unintentionally
                        continue;
                    }

                    if (onStreamChunk) {
                        const delta = chunk.choices[0]?.delta;
                        if (!delta?.content) continue;

                        buffer += delta.content ?? '';

                        const magmaChunk: MagmaStreamChunk = {
                            id: chunk.id,
                            provider: 'openai',
                            model: openAIConfig.model,
                            delta: {
                                content: delta.content,
                                role: delta.role === 'tool' ? 'tool_call' : 'assistant',
                            },
                            buffer,
                        };

                        onStreamChunk(magmaChunk);
                    }
                }

                let magmaMessage: MagmaMessage;
                if (streamedToolCalls.length > 0) {
                    // Convert the arguments buffer to an object
                    const toolCall = streamedToolCalls[0];
                    toolCall.arguments = JSON.parse(toolCall.argumentsBuffer);

                    magmaMessage = {
                        role: 'tool_call',
                        tool_call_id: toolCall.id,
                        fn_name: toolCall.name,
                        fn_args: toolCall.arguments,
                    };
                } else {
                    onStreamChunk();
                    magmaMessage = { role: 'assistant', content: buffer };
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'openai',
                    model: openAIConfig.model,
                    message: magmaMessage,
                    usage,
                };

                return magmaCompletion;
            } else {
                const openAICompletion = (await openai.chat.completions.create(openAIConfig, {
                    signal,
                })) as ChatCompletion;

                const openAIMessage = openAICompletion.choices[0].message;

                let magmaMessage: MagmaMessage;

                if (openAIMessage.tool_calls) {
                    const tool_call = openAIMessage.tool_calls[0];
                    magmaMessage = {
                        role: 'tool_call',
                        tool_call_id: tool_call.id,
                        fn_name: tool_call.function.name,
                        fn_args: JSON.parse(tool_call.function.arguments),
                    };
                } else {
                    magmaMessage = { role: 'assistant', content: openAIMessage.content };
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'openai',
                    model: openAICompletion.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: openAICompletion.usage.prompt_tokens,
                        output_tokens: openAICompletion.usage.completion_tokens,
                    },
                };

                return magmaCompletion;
            }
        } catch (error) {
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }
            if (error.response && error.response.status === 429) {
                if (attempt >= MAX_RETRIES) {
                    throw new Error(`Rate limited after ${MAX_RETRIES} attempts`);
                }
                const delay = Math.min(Math.pow(2, attempt) * 1000, 60000);
                Logger.main.warn(`Rate limited. Retrying after ${delay}ms.`);

                await sleep(delay);
                return this.makeCompletionRequest(config, onStreamChunk, attempt + 1);
            } else {
                throw error;
            }
        }
    }

    // Tool schema to LLM function call converter
    static override convertTools(tools: MagmaTool[]): OpenAITool[] {
        const openAITools: OpenAITool[] = [];

        for (const tool of tools) {
            const baseObject: MagmaToolParam = {
                type: 'object',
                properties: tool.params,
            };

            openAITools.push({
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: cleanParam(baseObject, []),
                },
                type: 'function',
            });
        }

        return openAITools;
    }

    // MagmaConfig to Provider-specific config converter
    static override convertConfig(config: MagmaConfig): ChatCompletionCreateParamsBase {
        const tools: OpenAITool[] | undefined = config.tools
            ? this.convertTools(config.tools)
            : undefined;

        let tool_choice = undefined;

        if (config.tool_choice === 'auto') tool_choice = 'auto';
        else if (config.tool_choice === 'required') tool_choice = 'required';
        else if (typeof config.tool_choice === 'string')
            tool_choice = { type: 'function', function: { name: config.tool_choice } };

        const model = config.providerConfig.model;

        delete config.providerConfig;

        const openAIConfig: ChatCompletionCreateParamsBase = {
            ...config,
            model,
            messages: this.convertMessages(config.messages),
            tools: tools,
            temperature: config.temperature
                ? mapNumberInRange(config.temperature, 0, 1, 0, 2)
                : undefined,
            tool_choice: tool_choice,
        };

        return openAIConfig;
    }

    // MagmaMessage to Provider-specific message converter
    static override convertMessages(messages: MagmaMessage[]): OpenAIMessageParam[] {
        const openAIMessages: OpenAIMessageParam[] = [];

        for (const message of messages) {
            if ('id' in message) delete message.id;

            switch (message.role) {
                case 'system':
                    openAIMessages.push({
                        role: 'system',
                        content: message.content,
                    });
                    break;

                case 'assistant':
                    openAIMessages.push({
                        role: 'assistant',
                        content: message.content,
                    });
                    break;

                case 'user':
                    openAIMessages.push({
                        role: 'user',
                        content: message.content,
                    });
                    break;

                case 'tool_call':
                    openAIMessages.push({
                        role: 'assistant',
                        tool_calls: [
                            {
                                type: 'function',
                                id: message.tool_call_id,
                                function: {
                                    name: message.fn_name,
                                    arguments: JSON.stringify(message.fn_args),
                                },
                            },
                        ],
                    });
                    break;

                case 'tool_result':
                    openAIMessages.push({
                        role: 'tool',
                        tool_call_id: message.tool_result_id,
                        content: message.tool_result_error
                            ? `Something went wrong calling your last tool - \n ${message.tool_result}`
                            : message.tool_result,
                    });
                    break;
            }
        }

        return openAIMessages;
    }
}

export class GroqProvider extends Provider {
    static override convertConfig(config: MagmaConfig): GroqConfig {
        const tools: GroqTool[] | undefined = config.tools
            ? this.convertTools(config.tools)
            : undefined;

        const model = config.providerConfig.model;

        let tool_choice = undefined;

        if (config.tool_choice === 'auto') tool_choice = 'auto';
        else if (config.tool_choice === 'required') tool_choice = 'required';
        else if (typeof config.tool_choice === 'string')
            tool_choice = { type: 'function', function: { name: config.tool_choice } };

        delete config.providerConfig;

        const groqConfig: GroqConfig = {
            ...config,
            model,
            messages: this.convertMessages(config.messages),
            tools,
            tool_choice,
            temperature: config.temperature
                ? mapNumberInRange(config.temperature, 0, 1, 0, 2)
                : undefined,
        };

        return groqConfig;
    }

    static override async makeCompletionRequest(
        config: MagmaConfig,
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
        attempt: number = 0,
        signal?: AbortSignal,
    ): Promise<MagmaCompletion> {
        try {
            const groq = config.providerConfig.client as Groq;
            if (!groq) throw new Error('Groq instance not configured');

            const groqConfig = this.convertConfig(config);

            if (config.stream) {
                const stream = await groq.chat.completions.create(
                    {
                        ...groqConfig,
                        stream: true,
                    },
                    { signal },
                );

                let buffer = '';
                const usage: MagmaUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                };

                const streamedToolCalls: {
                    id: string;
                    name: string;
                    argumentsBuffer: string;
                    arguments: Record<string, any>;
                }[] = [];

                for await (const chunk of stream) {
                    const delta = chunk?.choices[0]?.delta;

                    if (chunk.x_groq?.usage) {
                        usage.input_tokens = chunk.x_groq.usage.prompt_tokens ?? 0;
                        usage.output_tokens = chunk.x_groq.usage.completion_tokens ?? 0;
                        continue;
                    }

                    // First stream chunk telling us what tools are being called
                    if (delta?.tool_calls?.length > 0 && streamedToolCalls.length === 0) {
                        for (const toolCall of delta.tool_calls) {
                            streamedToolCalls.push({
                                id: toolCall.id,
                                name: toolCall.function.name,
                                argumentsBuffer: toolCall.function.arguments,
                                arguments: {},
                            });
                        }
                    } else if (delta?.tool_calls?.length > 0) {
                        // Subsequent stream chunks with tool call results buffering up
                        for (const toolCall of delta.tool_calls) {
                            streamedToolCalls[toolCall.index].argumentsBuffer +=
                                toolCall.function.arguments;
                        }
                    }

                    if (streamedToolCalls.length > 0) {
                        // We are still waiting for tool call results to come in
                        // We do NOT want to buffer the delta here, as it will be conflated as completion text
                        // and might go into a tts client unintentionally
                        continue;
                    }

                    if (onStreamChunk) {
                        const delta = chunk.choices[0]?.delta;
                        if (!delta?.content) continue;

                        buffer += delta.content ?? '';

                        const magmaChunk: MagmaStreamChunk = {
                            id: chunk.id,
                            provider: 'groq',
                            model: groqConfig.model,
                            delta: {
                                content: delta.content,
                                role: delta.role === 'tool' ? 'tool_call' : 'assistant',
                            },
                            buffer,
                        };

                        onStreamChunk(magmaChunk);
                    }
                }

                let magmaMessage: MagmaMessage;
                if (streamedToolCalls.length > 0) {
                    // Convert the arguments buffer to an object
                    const toolCall = streamedToolCalls[0];
                    toolCall.arguments = JSON.parse(toolCall.argumentsBuffer);

                    magmaMessage = {
                        role: 'tool_call',
                        tool_call_id: toolCall.id,
                        fn_name: toolCall.name,
                        fn_args: toolCall.arguments,
                    };
                } else {
                    onStreamChunk();
                    magmaMessage = { role: 'assistant', content: buffer };
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'groq',
                    model: groqConfig.model,
                    message: magmaMessage,
                    usage,
                };

                return magmaCompletion;
            } else {
                const groqCompletion = (await groq.chat.completions.create(groqConfig, {
                    signal,
                })) as ChatCompletion;

                const groqMessage = groqCompletion.choices[0].message;

                let magmaMessage: MagmaMessage;

                if (groqMessage.tool_calls) {
                    const tool_call = groqMessage.tool_calls[0];
                    magmaMessage = {
                        role: 'tool_call',
                        tool_call_id: tool_call.id,
                        fn_name: tool_call.function.name,
                        fn_args: JSON.parse(tool_call.function.arguments),
                    };
                } else {
                    magmaMessage = { role: 'assistant', content: groqMessage.content };
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'groq',
                    model: groqCompletion.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: groqCompletion.usage.prompt_tokens,
                        output_tokens: groqCompletion.usage.completion_tokens,
                    },
                };

                return magmaCompletion;
            }
        } catch (error) {
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }
            if (error.response && error.response.status === 429) {
                if (attempt >= MAX_RETRIES) {
                    throw new Error(`Rate limited after ${MAX_RETRIES} attempts`);
                }
                const delay = Math.min(Math.pow(2, attempt) * 1000, 60000);
                Logger.main.warn(`Rate limited. Retrying after ${delay}ms.`);

                await sleep(delay);
                return this.makeCompletionRequest(config, onStreamChunk, attempt + 1);
            } else {
                throw error;
            }
        }
    }

    static override convertTools(tools: MagmaTool[]): GroqTool[] {
        const groqTools: GroqTool[] = [];

        for (const tool of tools) {
            const baseObject: MagmaToolParam = {
                type: 'object',
                properties: tool.params,
            };

            groqTools.push({
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: cleanParam(baseObject, []),
                },
                type: 'function',
            });
        }

        return groqTools;
    }

    static override convertMessages(messages: MagmaMessage[]): GroqMessageParam[] {
        const groqMessages: GroqMessageParam[] = [];

        for (const message of messages) {
            if ('id' in message) delete message.id;

            switch (message.role) {
                case 'system':
                    groqMessages.push({
                        role: 'system',
                        content: message.content,
                    });
                    break;

                case 'assistant':
                    groqMessages.push({
                        role: 'assistant',
                        content: message.content,
                    });
                    break;

                case 'user':
                    groqMessages.push({
                        role: 'user',
                        content: message.content,
                    });
                    break;

                case 'tool_call':
                    groqMessages.push({
                        role: 'assistant',
                        tool_calls: [
                            {
                                type: 'function',
                                id: message.tool_call_id,
                                function: {
                                    name: message.fn_name,
                                    arguments: JSON.stringify(message.fn_args),
                                },
                            },
                        ],
                    });
                    break;

                case 'tool_result':
                    groqMessages.push({
                        role: 'tool',
                        tool_call_id: message.tool_result_id,
                        content: message.tool_result_error
                            ? `Something went wrong calling your last tool - \n ${message.tool_result}`
                            : message.tool_result,
                    });
                    break;
            }
        }

        return groqMessages;
    }
}
