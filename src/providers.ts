import {
    ChatCompletionMessageParam as OpenAIMessageParam,
    ChatCompletionTool as OpenAITool,
} from 'openai/resources/index.mjs';
import { mapNumberInRange, sleep } from './helpers';
import { Logger } from './logger';
import {
    MagmaTool,
    MagmaConfig,
    MagmaMessage,
    MagmaCompletion,
    MagmaProvider,
    MagmaToolParam,
    MagmaStreamChunk,
} from './types';
import { ChatCompletionCreateParamsNonStreaming } from 'openai/src/resources/index.js';
import {
    MessageCreateParamsBase as AnthropicConfig,
    MessageParam as AnthropicMessageParam,
    Tool as AnthropicTool,
    Message as AnthropicMessage,
} from '@anthropic-ai/sdk/resources/messages.mjs';
import { cleanParam } from './helpers';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
    ChatCompletion,
    ChatCompletionCreateParamsBase,
} from 'openai/resources/chat/completions.mjs';

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
            default:
                throw new Error(`Can not create factory class Provider with type ${name}`);
        }
    }

    static convertMessages(messages: MagmaMessage[]): object[] {
        throw new Error('Provider.convertMessages not implemented');
    }

    static async makeCompletionRequest(
        config: MagmaConfig,
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
        attempt: number = 0,
    ): Promise<MagmaCompletion> {
        throw new Error('Provider.makeCompletionRequest not implemented');
    }

    static convertTools(tools: MagmaTool[]): object[] {
        throw new Error('Provider.convertTools not implemented');
    }

    static convertConfig(config: MagmaConfig): object {
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
        attempt?: number,
    ): Promise<MagmaCompletion> {
        try {
            const anthropic = config.providerConfig.client as Anthropic;
            if (!anthropic) throw new Error('Anthropic instance not configured');

            const anthropicConfig = this.convertConfig(config);

            if (config.stream) {
                const stream = await anthropic.messages.create({
                    ...anthropicConfig,
                    stream: true,
                });

                let buffer = '';
                const usage: {
                    input_tokens: number;
                    output_tokens: number;
                } = {
                    input_tokens: 0,
                    output_tokens: 0,
                };
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
                            }
                            break;
                        case 'message_stop': {
                            onStreamChunk();
                            const magmaCompletion: MagmaCompletion = {
                                provider: 'anthropic',
                                model: anthropicConfig.model,
                                message: { role: 'assistant', content: buffer },
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
                const anthropicCompletion = (await anthropic.messages.create(
                    anthropicConfig,
                )) as AnthropicMessage;

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
        attempt?: number,
    ): Promise<MagmaCompletion> {
        try {
            const openai = config.providerConfig.client as OpenAI;
            if (!openai) throw new Error('OpenAI instance not configured');

            const openAIConfig = this.convertConfig(config);

            if (config.stream) {
                const stream = await openai.chat.completions.create({
                    ...openAIConfig,
                    stream: true,
                    stream_options: { include_usage: true },
                });

                let buffer = '';
                for await (const chunk of stream) {
                    if (onStreamChunk) {
                        const delta = chunk.choices[0].delta;
                        buffer += delta.content ?? '';

                        const magmaChunk: MagmaStreamChunk = {
                            id: chunk.id,
                            provider: 'openai',
                            model: openAIConfig.model,
                            delta: {
                                content: delta.content,
                                role: delta.role === 'tool' ? 'tool_call' : 'assistant',
                            },
                            buffer: buffer,
                            usage: {
                                input_tokens: chunk.usage?.prompt_tokens ?? 0,
                                output_tokens: chunk.usage?.completion_tokens ?? 0,
                            },
                        };

                        onStreamChunk(magmaChunk);
                    }

                    if (chunk.choices[0].finish_reason === 'stop') {
                        onStreamChunk();
                        const magmaCompletion: MagmaCompletion = {
                            provider: 'openai',
                            model: openAIConfig.model,
                            message: { role: 'assistant', content: buffer },
                            usage: {
                                input_tokens: chunk.usage?.prompt_tokens ?? 0,
                                output_tokens: chunk.usage?.completion_tokens ?? 0,
                            },
                        };

                        return magmaCompletion;
                    }
                }
            } else {
                const openAICompletion = (await openai.chat.completions.create(
                    openAIConfig,
                )) as ChatCompletion;

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
