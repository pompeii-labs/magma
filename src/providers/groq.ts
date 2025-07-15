import { MAX_RETRIES, Provider } from '.';
import {
    GroqProviderConfig,
    MagmaAssistantMessage,
    MagmaCompletion,
    MagmaCompletionConfig,
    MagmaCompletionStopReason,
    MagmaMessage,
    MagmaStreamChunk,
    MagmaTextBlock,
    MagmaTool,
    MagmaToolCallBlock,
    MagmaToolParam,
    MagmaUsage,
    TraceEvent,
} from '../types';
import {
    ChatCompletionTool as GroqTool,
    ChatCompletionMessageParam as GroqMessageParam,
    ChatCompletionCreateParamsBase as GroqConfig,
    ChatCompletionChunk,
    ChatCompletion,
    ChatCompletionUserMessageParam,
} from 'groq-sdk/resources/chat/completions';
import Groq from 'groq-sdk';
import { cleanParam, parseErrorToString, sleep } from '../helpers';
import { safeJSON } from 'groq-sdk/core';
import type { MagmaAgent } from '../agent';

export class GroqProvider extends Provider {
    static override convertConfig(config: MagmaCompletionConfig): GroqConfig {
        const { model, settings } = config.providerConfig as GroqProviderConfig;

        const groqConfig: GroqConfig = {
            stream: config.stream,
            model,
            messages: this.convertMessages(config.messages),
            tools: this.convertTools(config.tools),
            ...settings,
        };

        return groqConfig;
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
            const groq = config.providerConfig.client as Groq;
            if (!groq) throw new Error('Groq instance not configured');

            const groqConfig = this.convertConfig(config);

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
                const stream = await groq.chat.completions.create(
                    {
                        ...groqConfig,
                        stream: true,
                    },
                    { signal }
                );

                let contentBuffer = '';
                const usage: MagmaUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_write_tokens: 0,
                    cache_read_tokens: 0,
                };

                let streamedToolCalls: {
                    [index: number]: ChatCompletionChunk.Choice.Delta.ToolCall;
                } = {};

                let stopReason: MagmaCompletionStopReason = 'unknown';

                for await (const chunk of stream) {
                    let magmaStreamChunk: MagmaStreamChunk = {
                        id: chunk.id,
                        provider: 'groq',
                        model: chunk.model,
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

                    const choice = chunk.choices[0];
                    const delta = choice?.delta;

                    if (choice?.finish_reason) {
                        stopReason = this.convertStopReason(choice.finish_reason);
                        magmaStreamChunk.stop_reason = stopReason;
                    }

                    for (const toolCall of delta?.tool_calls ?? []) {
                        const { index } = toolCall;

                        if (!streamedToolCalls[index]) {
                            streamedToolCalls[index] = toolCall;
                        } else {
                            if (streamedToolCalls[index].function) {
                                streamedToolCalls[index].function.arguments +=
                                    toolCall.function?.arguments ?? '';
                            } else {
                                streamedToolCalls[index].function = toolCall.function;
                            }
                        }
                    }

                    if (chunk.x_groq?.usage) {
                        usage.input_tokens = chunk.x_groq.usage.prompt_tokens;
                        usage.output_tokens = chunk.x_groq.usage.completion_tokens;
                        usage.cache_write_tokens = 0;
                        usage.cache_read_tokens = 0;
                        magmaStreamChunk.usage = {
                            input_tokens: chunk.x_groq.usage.prompt_tokens,
                            output_tokens: chunk.x_groq.usage.completion_tokens,
                            cache_write_tokens: 0,
                            cache_read_tokens: 0,
                        };
                    }

                    if (delta?.tool_calls) {
                        const toolCallBlocks: MagmaToolCallBlock[] = delta.tool_calls.map(
                            (toolCall) => ({
                                type: 'tool_call',
                                tool_call: {
                                    id:
                                        streamedToolCalls[toolCall.index].id ??
                                        'gen-' + Math.random().toString(36).substring(2, 15),
                                    fn_name: toolCall.function?.name ?? '',
                                    fn_args: safeJSON(toolCall.function?.arguments ?? '') ?? {},
                                    fn_args_buffer: toolCall.function?.arguments ?? '',
                                },
                            })
                        );
                        magmaStreamChunk.delta.blocks.push(...toolCallBlocks);
                    }

                    if (delta?.content) {
                        const textBlock: MagmaTextBlock = {
                            type: 'text',
                            text: delta.content,
                        };
                        magmaStreamChunk.delta.blocks.push(textBlock);
                        contentBuffer += delta.content;
                    }

                    if (contentBuffer.length > 0) {
                        const bufferTextBlock: MagmaTextBlock = {
                            type: 'text',
                            text: contentBuffer,
                        };
                        magmaStreamChunk.buffer.blocks.push(bufferTextBlock);
                    }

                    if (Object.keys(streamedToolCalls).length > 0) {
                        const bufferToolCallBlocks: MagmaToolCallBlock[] = Object.values(
                            streamedToolCalls
                        ).map((toolCall) => ({
                            type: 'tool_call',
                            tool_call: {
                                id:
                                    toolCall.id ??
                                    'gen-' + Math.random().toString(36).substring(2, 15),
                                fn_name: toolCall.function?.name ?? '',
                                fn_args: safeJSON(toolCall.function?.arguments ?? '') ?? {},
                                fn_args_buffer: toolCall.function?.arguments ?? '',
                            },
                        }));
                        magmaStreamChunk.buffer.blocks.push(...bufferToolCallBlocks);
                    }

                    onStreamChunk?.(magmaStreamChunk);
                }

                let magmaMessage = new MagmaAssistantMessage({ role: 'assistant', blocks: [] });

                if (contentBuffer.length > 0) {
                    magmaMessage.blocks.push({
                        type: 'text',
                        text: contentBuffer,
                    });
                }

                const toolCalls = Object.values(streamedToolCalls);
                if (toolCalls.length > 0) {
                    const toolCallBlocks: MagmaToolCallBlock[] = toolCalls.map((toolCall) => ({
                        type: 'tool_call',
                        tool_call: {
                            id: toolCall.id ?? 'gen-' + Math.random().toString(36).substring(2, 15),
                            fn_name: toolCall.function?.name ?? '',
                            fn_args: safeJSON(toolCall.function?.arguments ?? '') ?? {},
                            fn_args_buffer: toolCall.function?.arguments ?? '',
                        },
                    }));
                    magmaMessage.blocks.push(...toolCallBlocks);
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'groq',
                    model: groqConfig.model,
                    message: magmaMessage,
                    usage,
                    stop_reason: stopReason,
                };

                onStreamChunk?.(null);

                trace.push({
                    type: 'completion',
                    phase: 'end',
                    status: 'success',
                    requestId,
                    timestamp: Date.now(),
                    data: { completion: magmaCompletion },
                });

                return magmaCompletion;
            } else {
                const groqCompletion = await groq.chat.completions.create(
                    {
                        ...groqConfig,
                        stream: false,
                    },
                    { signal }
                );

                const choice = groqCompletion.choices[0];
                const groqMessage = choice?.message;

                let magmaMessage = new MagmaAssistantMessage({ role: 'assistant', blocks: [] });

                if (groqMessage?.content) {
                    magmaMessage.blocks.push({
                        type: 'text',
                        text: groqMessage.content,
                    });
                }

                if (groqMessage?.tool_calls) {
                    const toolCallBlocks: MagmaToolCallBlock[] = groqMessage.tool_calls.map(
                        (tool_call) => ({
                            type: 'tool_call',
                            tool_call: {
                                id: tool_call.id,
                                fn_name: tool_call.function.name,
                                fn_args: safeJSON(tool_call.function.arguments) ?? {},
                                fn_args_buffer: tool_call.function.arguments,
                            },
                        })
                    );
                    magmaMessage.blocks.push(...toolCallBlocks);
                }

                if (magmaMessage.blocks.length === 0) {
                    return null;
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'groq',
                    model: groqConfig.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: groqCompletion.usage?.prompt_tokens ?? 0,
                        output_tokens: groqCompletion.usage?.completion_tokens ?? 0,
                        cache_write_tokens: 0,
                        cache_read_tokens: 0,
                    },
                    stop_reason: this.convertStopReason(choice?.finish_reason),
                };

                trace.push({
                    type: 'completion',
                    phase: 'end',
                    status: 'success',
                    requestId,
                    timestamp: Date.now(),
                    data: { completion: magmaCompletion },
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
                    data: { error: parseErrorToString(error) },
                });
                return null;
            }
            if ((error as any).response && (error as any).response.status === 429) {
                trace.push({
                    type: 'completion',
                    phase: 'end',
                    status: 'error',
                    requestId,
                    timestamp: Date.now(),
                    data: { error: parseErrorToString(error) },
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
                    data: { error: parseErrorToString(error) },
                });
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

    // MagmaMessage to Provider-specific message converter
    static override convertMessages(messages: MagmaMessage[]): GroqMessageParam[] {
        const groqMessages: GroqMessageParam[] = messages
            .filter((m) => m.role === 'system')
            .map((m) => ({
                role: m.role,
                content: m.getText(),
            }));

        for (const message of messages) {
            if ('id' in message) delete message.id;

            switch (message.role) {
                case 'system':
                    break;
                case 'assistant':
                    const reasoning = message.getReasoning();
                    const assistantText = message.getText();
                    const toolCalls = message.getToolCalls();

                    let textWithReasoning = '';
                    if (reasoning.length > 0)
                        textWithReasoning += `<thinking>${reasoning}</thinking>\n`;
                    if (assistantText.length > 0) textWithReasoning += `${assistantText}`;

                    if (textWithReasoning.length > 0) {
                        groqMessages.push({
                            role: 'assistant',
                            content: textWithReasoning,
                        });
                    }

                    if (toolCalls.length > 0) {
                        groqMessages.push({
                            role: 'assistant',
                            tool_calls: toolCalls.map((toolCall) => ({
                                type: 'function',
                                id: toolCall.id,
                                function: {
                                    name: toolCall.fn_name,
                                    arguments: JSON.stringify(toolCall.fn_args),
                                },
                            })),
                        });
                    }
                    break;
                case 'user':
                    const userText = message.getText();
                    const images = message.getImages();
                    const toolResults = message.getToolResults();

                    const content: ChatCompletionUserMessageParam['content'] = [];

                    if (userText.length > 0) {
                        content.push({ type: 'text', text: userText });
                    }

                    for (const image of images) {
                        // If image is a string, it is a url
                        if (image.type === 'image/url') {
                            content.push({
                                type: 'image_url',
                                image_url: {
                                    url: image.data,
                                },
                            });
                        } else {
                            content.push({
                                type: 'image_url',
                                image_url: {
                                    url: `data:${image.type};base64,${image.data}`,
                                },
                            });
                        }
                    }

                    if (toolResults.length > 0) {
                        for (const toolResult of toolResults) {
                            groqMessages.push({
                                role: 'tool',
                                tool_call_id: toolResult.id,
                                content: toolResult.error
                                    ? `Something went wrong calling your last tool - \n ${typeof toolResult.result !== 'string' ? JSON.stringify(toolResult.result) : toolResult.result}`
                                    : typeof toolResult.result !== 'string'
                                      ? JSON.stringify(toolResult.result)
                                      : toolResult.result,
                            });
                        }
                    }

                    if (content.length > 0) {
                        groqMessages.push({
                            role: 'user',
                            content,
                        });
                    }
                    break;
            }
        }

        return groqMessages;
    }

    static override convertStopReason(
        stop_reason: ChatCompletion.Choice['finish_reason']
    ): MagmaCompletionStopReason {
        switch (stop_reason) {
            case 'stop':
                return 'natural';
            case 'tool_calls':
            case 'function_call':
                return 'tool_call';
            case 'length':
                return 'max_tokens';
            default:
                return 'unknown';
        }
    }
}
