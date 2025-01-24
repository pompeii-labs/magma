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
    ToolUseBlock,
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
                        content: message.tool_calls.map((toolCall) => ({
                            type: 'tool_use',
                            id: toolCall.id,
                            name: toolCall.fn_name,
                            input: toolCall.fn_args,
                        })),
                    });
                    break;

                case 'tool_result':
                    anthropicMessages.push({
                        role: 'user',
                        content: message.tool_results.map((toolResult) => ({
                            type: 'tool_result',
                            tool_use_id: toolResult.id,
                            content: toolResult.result,
                            is_error: toolResult.error,
                        })),
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
        onStreamChunk?: (chunk: MagmaStreamChunk | null) => Promise<void>,
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

                let contentBuffer = '';
                const usage: {
                    input_tokens: number;
                    output_tokens: number;
                } = {
                    input_tokens: 0,
                    output_tokens: 0,
                };

                let streamedToolCalls: ToolUseBlock[] = [];

                let id = stream._request_id;

                for await (const chunk of stream) {
                    let magmaStreamChunk: MagmaStreamChunk = {
                        id,
                        provider: 'anthropic',
                        model: anthropicConfig.model,
                        delta: {
                            content: null,
                            tool_calls: null,
                        },
                        buffer: {
                            content: null,
                            tool_calls: null,
                        },
                        usage: {
                            input_tokens: null,
                            output_tokens: null,
                        },
                    };

                    switch (chunk.type) {
                        case 'message_start':
                            id = chunk.message.id;
                            magmaStreamChunk.id = id;
                            usage.input_tokens += chunk.message.usage.input_tokens;
                            usage.output_tokens += chunk.message.usage.output_tokens;
                            magmaStreamChunk.usage.input_tokens = chunk.message.usage.input_tokens;
                            magmaStreamChunk.usage.output_tokens =
                                chunk.message.usage.output_tokens;
                            break;
                        case 'message_delta':
                            usage.output_tokens += chunk.usage.output_tokens;
                            magmaStreamChunk.usage.output_tokens = chunk.usage.output_tokens;
                            break;
                        case 'content_block_start':
                            if (chunk.content_block.type === 'tool_use') {
                                streamedToolCalls.push({
                                    id: chunk.content_block.id,
                                    type: 'tool_use',
                                    name: chunk.content_block.name,
                                    input: '',
                                });
                                magmaStreamChunk.delta.tool_calls = [
                                    {
                                        id: chunk.content_block.id,
                                        name: chunk.content_block.name,
                                    },
                                ];
                            }
                            break;
                        case 'content_block_delta':
                            if (chunk.delta.type === 'text_delta') {
                                contentBuffer += chunk.delta.text;
                                magmaStreamChunk.delta.content = chunk.delta.text;
                            } else if (chunk.delta.type === 'input_json_delta') {
                                streamedToolCalls.at(-1).input += chunk.delta.partial_json;
                                magmaStreamChunk.delta.tool_calls = [
                                    {
                                        id: streamedToolCalls.at(-1).id,
                                        arguments: chunk.delta.partial_json,
                                    },
                                ];
                            }
                            break;
                        case 'message_stop': {
                            let magmaMessage: MagmaMessage;

                            if (streamedToolCalls.length > 0) {
                                magmaMessage = {
                                    role: 'tool_call',
                                    tool_calls: streamedToolCalls.map((toolCall) => ({
                                        id: toolCall.id,
                                        fn_name: toolCall.name,
                                        fn_args: JSON.parse(toolCall.input as string),
                                    })),
                                    content: contentBuffer,
                                };
                            } else {
                                magmaMessage = {
                                    role: 'assistant',
                                    content: contentBuffer,
                                };
                            }

                            onStreamChunk?.(null);

                            const magmaCompletion: MagmaCompletion = {
                                provider: 'anthropic',
                                model: anthropicConfig.model,
                                message: magmaMessage,
                                usage: usage,
                            };

                            return magmaCompletion;
                        }
                    }

                    if (streamedToolCalls.length > 0) {
                        magmaStreamChunk.buffer.tool_calls = streamedToolCalls.map((toolCall) => ({
                            id: toolCall.id,
                            name: toolCall.name,
                            arguments: toolCall.input as string,
                        }));
                    }

                    if (contentBuffer.length > 0) {
                        magmaStreamChunk.buffer.content = contentBuffer;
                    }

                    onStreamChunk?.(magmaStreamChunk);
                }
            } else {
                const anthropicCompletion = (await anthropic.messages.create(anthropicConfig, {
                    signal,
                })) as AnthropicMessage;

                const blocks = anthropicCompletion.content;

                const content = blocks
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n');
                const toolCalls = blocks.filter((b) => b.type === 'tool_use');

                let magmaMessage: MagmaMessage;
                if (content.length === 0 && toolCalls.length === 0) {
                    throw new Error('Anthropic completion was null');
                }

                if (toolCalls.length > 0) {
                    magmaMessage = {
                        role: 'tool_call',
                        tool_calls: toolCalls.map((toolCall) => ({
                            id: toolCall.id,
                            fn_name: toolCall.name,
                            fn_args: toolCall.input,
                        })),
                    };
                    if (content.length > 0) {
                        magmaMessage.content = content;
                    }
                } else if (content.length > 0) {
                    magmaMessage = {
                        role: 'assistant',
                        content,
                    };
                } else {
                    console.log(JSON.stringify(anthropicCompletion, null, 2));
                    throw new Error('Anthropic completion was null');
                }

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
