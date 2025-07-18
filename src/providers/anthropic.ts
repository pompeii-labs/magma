import Anthropic from '@anthropic-ai/sdk';
import { MAX_RETRIES, Provider } from '.';
import {
    AnthropicProviderConfig,
    MagmaAssistantMessage,
    MagmaCompletion,
    MagmaCompletionConfig,
    MagmaCompletionStopReason,
    MagmaContentBlock,
    MagmaMessage,
    MagmaReasoningBlock,
    MagmaStreamChunk,
    MagmaSystemMessage,
    MagmaTextBlock,
    MagmaTool,
    MagmaToolCall,
    MagmaToolCallBlock,
    MagmaToolParam,
    MagmaUsage,
    TraceEvent,
} from '../types';

import {
    MessageCreateParamsBase as AnthropicConfig,
    MessageParam as AnthropicMessageParam,
    Tool as AnthropicTool,
    Message as AnthropicMessage,
    Message,
    TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import { cleanParam, parseErrorToString, sleep } from '../helpers';
import { safeJSON } from '@anthropic-ai/sdk/core';
import type { MagmaAgent } from '../agent';

export class AnthropicProvider extends Provider {
    static override convertConfig(config: MagmaCompletionConfig): AnthropicConfig {
        const { model, settings } = config.providerConfig as AnthropicProviderConfig;

        const anthropicConfig: AnthropicConfig = {
            stream: config.stream,
            model,
            messages: this.convertMessages(config.messages),
            max_tokens: settings?.max_tokens ?? (model.includes('claude-3-5') ? 8192 : 4096),
            tools: this.convertTools(config.tools),
            system: config.messages
                .filter((m) => m.role === 'system')
                .flatMap((m) =>
                    m.blocks
                        .filter((b) => b.type === 'text')
                        .map((b) => ({
                            type: 'text',
                            text: b.text,
                            cache_control: b.cache ? { type: 'ephemeral' } : undefined,
                        }))
                ),
            ...settings,
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
                    let assistantContent: AnthropicMessageParam['content'] = [];

                    for (const block of message.blocks) {
                        switch (block.type) {
                            case 'reasoning':
                                if (block.redacted) {
                                    assistantContent.push({
                                        type: 'redacted_thinking',
                                        data: block.reasoning,
                                    });
                                } else {
                                    if (!block.signature) {
                                        assistantContent.push({
                                            type: 'text',
                                            text: `<thinking>${block.reasoning}</thinking>`,
                                        });
                                    } else {
                                        assistantContent.push({
                                            type: 'thinking',
                                            thinking: block.reasoning,
                                            signature: block.signature,
                                        });
                                    }
                                }
                                break;
                            case 'tool_call':
                                assistantContent.push({
                                    type: 'tool_use',
                                    id: block.tool_call.id,
                                    name: block.tool_call.fn_name,
                                    input: block.tool_call.fn_args,
                                });
                                break;
                            case 'text':
                                assistantContent.push({
                                    type: 'text',
                                    text: block.text,
                                });
                                break;
                            default:
                                throw new Error(
                                    `Unsupported block type for assistant messages: ${block.type}`
                                );
                        }
                    }

                    anthropicMessages.push({
                        role: 'assistant',
                        content: assistantContent,
                    });

                    // Check if the next message is also from the assistant
                    if (
                        i + 1 < messages.length &&
                        messages[i + 1].role === 'assistant' &&
                        messages[i].getToolCalls().length === 0
                    ) {
                        anthropicMessages.push({
                            role: 'user',
                            content: 'Continue.',
                        });
                    }
                    break;

                case 'user':
                    let userContent: AnthropicMessageParam['content'] = [];

                    for (const block of message.blocks) {
                        switch (block.type) {
                            case 'text':
                                userContent.push({
                                    type: 'text',
                                    text: block.text,
                                });
                                break;
                            case 'image':
                                if (block.image.type === 'image/url') {
                                    userContent.push({
                                        type: 'image',
                                        source: {
                                            type: 'url',
                                            url: block.image.data,
                                        },
                                    });
                                } else {
                                    userContent.push({
                                        type: 'image',
                                        source: {
                                            type: 'base64',
                                            data: block.image.data,
                                            media_type: block.image.type,
                                        },
                                    });
                                }
                                break;
                            case 'tool_result':
                                userContent.push({
                                    type: 'tool_result',
                                    tool_use_id: block.tool_result.id,
                                    content:
                                        typeof block.tool_result.result !== 'string'
                                            ? JSON.stringify(block.tool_result.result)
                                            : block.tool_result.result,
                                });
                                break;
                            default:
                                throw new Error(
                                    `Unsupported block type for user messages: ${block.type}`
                                );
                        }
                    }

                    anthropicMessages.push({
                        role: 'user',
                        content: userContent,
                    });
                    break;
            }
        }

        if (anthropicMessages.length === 0 || anthropicMessages[0].role != 'user')
            anthropicMessages.unshift({
                role: 'user',
                content: 'begin',
            });

        return anthropicMessages;
    }

    static override async makeCompletionRequest({
        config,
        onStreamChunk,
        attempt = 0,
        signal,
        agent,
        trace,
        requestId,
    }: {
        config: MagmaCompletionConfig;
        onStreamChunk?: (chunk: MagmaStreamChunk | null) => Promise<void>;
        attempt: number;
        signal?: AbortSignal;
        agent: MagmaAgent;
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaCompletion | null> {
        try {
            const anthropic = config.providerConfig.client as Anthropic;
            if (!anthropic) throw new Error('Anthropic instance not configured');

            const anthropicConfig = this.convertConfig(config);

            trace.push({
                type: 'completion',
                phase: 'start',
                requestId,
                timestamp: Date.now(),
                data: {
                    message: config.messages.at(-1),
                },
            });

            if (config.stream) {
                const stream = await anthropic.messages.create(
                    {
                        ...anthropicConfig,
                        stream: true,
                    },
                    { signal }
                );

                let blockBuffer: MagmaContentBlock[] = [];
                const usage: MagmaUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_write_tokens: 0,
                    cache_read_tokens: 0,
                };

                let id = stream._request_id ?? 'gen-' + Math.random().toString(36).substring(2, 15);

                let stopReason: MagmaCompletionStopReason = 'unknown';

                for await (const chunk of stream) {
                    let magmaStreamChunk: MagmaStreamChunk = {
                        id,
                        provider: 'anthropic',
                        model: anthropicConfig.model,
                        delta: new MagmaAssistantMessage({ role: 'assistant', blocks: [] }),
                        buffer: new MagmaAssistantMessage({ role: 'assistant', blocks: [] }),
                        usage: {
                            input_tokens: null,
                            output_tokens: null,
                            cache_write_tokens: null,
                            cache_read_tokens: null,
                        },
                        stop_reason: undefined,
                    };

                    switch (chunk.type) {
                        case 'message_start':
                            id = chunk.message.id;
                            magmaStreamChunk.id = id;
                            usage.input_tokens += chunk.message.usage.input_tokens;
                            usage.output_tokens += chunk.message.usage.output_tokens;
                            usage.cache_write_tokens +=
                                chunk.message.usage.cache_creation_input_tokens ?? 0;
                            usage.cache_read_tokens +=
                                chunk.message.usage.cache_read_input_tokens ?? 0;
                            magmaStreamChunk.usage.input_tokens = chunk.message.usage.input_tokens;
                            magmaStreamChunk.usage.output_tokens =
                                chunk.message.usage.output_tokens;
                            magmaStreamChunk.usage.cache_write_tokens =
                                chunk.message.usage.cache_creation_input_tokens;
                            magmaStreamChunk.usage.cache_read_tokens =
                                chunk.message.usage.cache_read_input_tokens;
                            break;
                        case 'message_delta':
                            usage.output_tokens += chunk.usage.output_tokens;
                            magmaStreamChunk.usage.output_tokens = chunk.usage.output_tokens;
                            if (chunk.delta.stop_reason) {
                                stopReason = this.convertStopReason(chunk.delta.stop_reason);
                                magmaStreamChunk.stop_reason = stopReason;
                            }
                            break;
                        case 'content_block_start':
                            let blockStart: MagmaContentBlock;
                            switch (chunk.content_block.type) {
                                case 'text':
                                    blockStart = {
                                        type: 'text',
                                        text: chunk.content_block.text,
                                    };
                                    break;
                                case 'thinking':
                                    blockStart = {
                                        type: 'reasoning',
                                        reasoning: chunk.content_block.thinking,
                                        signature: chunk.content_block.signature,
                                    };
                                    break;
                                case 'redacted_thinking':
                                    blockStart = {
                                        type: 'reasoning',
                                        reasoning: chunk.content_block.data,
                                        redacted: true,
                                    };
                                    break;
                                case 'tool_use':
                                    blockStart = {
                                        type: 'tool_call',
                                        tool_call: {
                                            id: chunk.content_block.id,
                                            fn_name: chunk.content_block.name,
                                            fn_args: {},
                                            fn_args_buffer: '',
                                        },
                                    };
                                    break;
                            }
                            blockBuffer[chunk.index] = blockStart;
                            magmaStreamChunk.delta.blocks.push(blockStart as MagmaContentBlock);
                            break;
                        case 'content_block_delta':
                            let blockToChange: MagmaContentBlock = blockBuffer[chunk.index];
                            switch (chunk.delta.type) {
                                case 'text_delta':
                                    blockToChange = blockBuffer[chunk.index] as MagmaTextBlock;
                                    blockToChange.text += chunk.delta.text;
                                    magmaStreamChunk.delta.blocks.push({
                                        type: 'text',
                                        text: chunk.delta.text,
                                    });
                                    break;
                                case 'input_json_delta':
                                    blockToChange = blockBuffer[chunk.index] as MagmaToolCallBlock;
                                    blockToChange.tool_call.fn_args_buffer +=
                                        chunk.delta.partial_json;
                                    magmaStreamChunk.delta.blocks.push({
                                        type: 'tool_call',
                                        tool_call: {
                                            id: blockToChange.tool_call.id,
                                            fn_name: blockToChange.tool_call.fn_name,
                                            fn_args: safeJSON(chunk.delta.partial_json) ?? {},
                                            fn_args_buffer: chunk.delta.partial_json,
                                        },
                                    });
                                    break;
                                case 'thinking_delta':
                                    blockToChange = blockBuffer[chunk.index] as MagmaReasoningBlock;
                                    blockToChange.reasoning += chunk.delta.thinking;
                                    magmaStreamChunk.delta.blocks.push({
                                        type: 'reasoning',
                                        reasoning: chunk.delta.thinking,
                                    });
                                    break;
                                case 'signature_delta':
                                    blockToChange = blockBuffer[chunk.index] as MagmaReasoningBlock;
                                    blockToChange.signature += chunk.delta.signature;
                                    magmaStreamChunk.delta.blocks.push({
                                        type: 'reasoning',
                                        reasoning: '',
                                        signature: chunk.delta.signature,
                                    });
                                    break;
                                default:
                                    throw new Error(`Unsupported delta type: ${chunk.delta.type}`);
                            }
                            break;
                        case 'message_stop': {
                            let magmaMessage: MagmaAssistantMessage = new MagmaAssistantMessage({
                                role: 'assistant',
                                blocks: blockBuffer.map((b) =>
                                    b.type === 'tool_call'
                                        ? {
                                              type: 'tool_call',
                                              tool_call: {
                                                  ...b.tool_call,
                                                  fn_args:
                                                      safeJSON(b.tool_call.fn_args_buffer ?? '') ??
                                                      {},
                                                  fn_args_buffer: b.tool_call.fn_args_buffer,
                                              },
                                          }
                                        : b
                                ),
                            });

                            const magmaCompletion: MagmaCompletion = {
                                provider: 'anthropic',
                                model: anthropicConfig.model,
                                message: magmaMessage,
                                usage: usage,
                                stop_reason: stopReason ?? 'unknown',
                            };

                            onStreamChunk?.(null);

                            trace.push({
                                type: 'completion',
                                phase: 'end',
                                status: 'success',
                                requestId,
                                timestamp: Date.now(),
                                data: {
                                    completion: magmaCompletion,
                                },
                            });

                            return magmaCompletion;
                        }
                    }

                    magmaStreamChunk.buffer.blocks = blockBuffer.map((b) =>
                        b.type === 'tool_call'
                            ? {
                                  type: 'tool_call',
                                  tool_call: {
                                      ...b.tool_call,
                                      fn_args: safeJSON(b.tool_call.fn_args_buffer ?? '') ?? {},
                                      fn_args_buffer: b.tool_call.fn_args_buffer,
                                  },
                              }
                            : b
                    );

                    onStreamChunk?.(magmaStreamChunk);
                }

                return null;
            } else {
                const anthropicCompletion = (await anthropic.messages.create(anthropicConfig, {
                    signal,
                })) as AnthropicMessage;

                const blocks = anthropicCompletion.content;

                let magmaMessage: MagmaAssistantMessage = new MagmaAssistantMessage({
                    role: 'assistant',
                    blocks: [],
                });

                for (const block of blocks) {
                    switch (block.type) {
                        case 'text':
                            magmaMessage.blocks.push({
                                type: 'text',
                                text: block.text,
                            });
                            break;
                        case 'tool_use':
                            magmaMessage.blocks.push({
                                type: 'tool_call',
                                tool_call: {
                                    id: block.id,
                                    fn_name: block.name,
                                    fn_args: block.input ?? {},
                                },
                            });
                            break;
                        case 'thinking':
                            magmaMessage.blocks.push({
                                type: 'reasoning',
                                reasoning: block.thinking,
                                signature: block.signature,
                            });
                            break;
                        case 'redacted_thinking':
                            magmaMessage.blocks.push({
                                type: 'reasoning',
                                reasoning: block.data,
                                redacted: true,
                            });
                            break;
                        default:
                            throw new Error(
                                `Unsupported block type for assistant messages: ${block}`
                            );
                    }
                }

                if (magmaMessage.blocks.length === 0) {
                    return null;
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'anthropic',
                    model: anthropicCompletion.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: anthropicCompletion.usage.input_tokens,
                        output_tokens: anthropicCompletion.usage.output_tokens,
                        cache_write_tokens:
                            anthropicCompletion.usage.cache_creation_input_tokens ?? 0,
                        cache_read_tokens: anthropicCompletion.usage.cache_read_input_tokens ?? 0,
                    },
                    stop_reason: this.convertStopReason(anthropicCompletion.stop_reason),
                };

                trace.push({
                    type: 'completion',
                    phase: 'end',
                    status: 'success',
                    requestId,
                    timestamp: Date.now(),
                    data: {
                        completion: magmaCompletion,
                    },
                });

                return magmaCompletion;
            }
        } catch (error) {
            if (signal?.aborted) {
                trace.push({
                    type: 'completion',
                    phase: 'end',
                    status: 'abort',
                    requestId,
                    timestamp: Date.now(),
                    data: {
                        error: parseErrorToString(error),
                    },
                });
                return null;
            }
            if ((error as any).error?.type === 'rate_limit_error') {
                trace.push({
                    type: 'completion',
                    phase: 'end',
                    status: 'error',
                    requestId,
                    timestamp: Date.now(),
                    data: {
                        error: parseErrorToString(error),
                    },
                });
                if (attempt >= MAX_RETRIES) {
                    throw new Error(`Rate limited after ${MAX_RETRIES} attempts`);
                }
                const delay = Math.min(Math.pow(2, attempt) * 1000, 60000);
                agent.log(`Rate limited. Retrying after ${delay}ms.`);

                await sleep(delay);
                return this.makeCompletionRequest({
                    config,
                    onStreamChunk,
                    attempt: attempt + 1,
                    signal,
                    agent,
                    trace,
                    requestId,
                });
            } else {
                trace.push({
                    type: 'completion',
                    phase: 'end',
                    status: 'error',
                    requestId,
                    timestamp: Date.now(),
                    data: {
                        error: parseErrorToString(error),
                    },
                });
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
                cache_control: tool.cache ? { type: 'ephemeral' } : undefined,
            });
        }

        return anthropicTools;
    }

    static override convertStopReason(
        stop_reason: Message['stop_reason'] | (string & {})
    ): MagmaCompletionStopReason {
        switch (stop_reason) {
            case 'end_turn':
                return 'natural';
            case 'max_tokens':
                return 'max_tokens';
            case 'tool_use':
                return 'tool_call';
            default:
                return 'unknown';
        }
    }
}
