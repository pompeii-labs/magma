import Anthropic from '@anthropic-ai/sdk';
import { MAX_RETRIES, Provider } from '.';
import {
    MagmaCompletion,
    MagmaConfig,
    MagmaMessage,
    MagmaStreamChunk,
    MagmaTool,
    MagmaToolParam,
} from '../types';

import {
    MessageCreateParamsBase as AnthropicConfig,
    MessageParam as AnthropicMessageParam,
    Tool as AnthropicTool,
    Message as AnthropicMessage,
    ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import { Logger } from '../logger';
import { cleanParam, sleep } from '../helpers';

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
            max_tokens: config.max_tokens ?? (model.includes('claude-3-5') ? 8192 : 4096),
            tools,
            tool_choice,
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
                    let imageContentParts: ImageBlockParam[] = [];
                    if (message.images) {
                        const images = Array.isArray(message.images)
                            ? message.images
                            : [message.images];
                        imageContentParts = [];

                        for (const image of images) {
                            if (typeof image === 'string') {
                                throw new Error('Image URLs are not supported by Anthropic');
                            } else if (image.type && image.data) {
                                imageContentParts.push({
                                    type: 'image',
                                    source: {
                                        data: image.data,
                                        media_type: image.type,
                                        type: 'base64',
                                    },
                                });
                            }
                        }
                    }

                    anthropicMessages.push({
                        role: 'user',
                        content:
                            imageContentParts.length > 0
                                ? [
                                      {
                                          type: 'text',
                                          text: message.content,
                                      },
                                      ...imageContentParts,
                                  ]
                                : message.content,
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

        return anthropicMessages;
    }

    static override async makeCompletionRequest(
        config: MagmaConfig,
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
        attempt: number = 0,
        signal?: AbortSignal
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
                    { signal }
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
