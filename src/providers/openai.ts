import OpenAI from 'openai';
import { MAX_RETRIES, Provider } from '.';
import {
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
    OpenAIProviderConfig,
} from '../types';
import { Logger } from '../logger';
import {
    ChatCompletionMessageParam as OpenAIMessageParam,
    ChatCompletionTool as OpenAITool,
} from 'openai/resources/index';
import { cleanParam, sleep } from '../helpers';
import {
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions/completions';
import { safeJSON } from 'openai/core';

export class OpenAIProvider extends Provider {
    static override async makeCompletionRequest(
        config: MagmaCompletionConfig,
        onStreamChunk?: (chunk: MagmaStreamChunk | null) => Promise<void>,
        attempt: number = 0,
        signal?: AbortSignal
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

                let stopReason: MagmaCompletionStopReason = null;

                for await (const chunk of stream) {
                    let magmaStreamChunk: MagmaStreamChunk = {
                        id: chunk.id,
                        provider: 'openai',
                        model: chunk.model,
                        delta: new MagmaAssistantMessage({ role: 'assistant', blocks: [] }),
                        buffer: new MagmaAssistantMessage({ role: 'assistant', blocks: [] }),
                        usage: {
                            input_tokens: null,
                            output_tokens: null,
                            cache_write_tokens: null,
                            cache_read_tokens: null,
                        },
                        stop_reason: null,
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
                            streamedToolCalls[index].function.arguments +=
                                toolCall.function.arguments;
                        }
                    }

                    if (chunk.usage) {
                        usage.input_tokens =
                            chunk.usage.prompt_tokens -
                            (chunk.usage.prompt_tokens_details.cached_tokens ?? 0);
                        usage.output_tokens = chunk.usage.completion_tokens;
                        usage.cache_write_tokens =
                            chunk.usage.prompt_tokens_details.cached_tokens ?? 0;
                        usage.cache_read_tokens = 0;
                        magmaStreamChunk.usage = {
                            input_tokens: chunk.usage.prompt_tokens,
                            output_tokens: chunk.usage.completion_tokens,
                            cache_write_tokens:
                                chunk.usage.prompt_tokens_details.cached_tokens ?? 0,
                            cache_read_tokens: 0,
                        };
                    }

                    if (delta?.tool_calls) {
                        const toolCallBlocks: MagmaToolCallBlock[] = delta.tool_calls.map(
                            (toolCall) => ({
                                type: 'tool_call',
                                tool_call: {
                                    id: streamedToolCalls[toolCall.index].id,
                                    fn_name: toolCall.function.name,
                                    fn_args: safeJSON(toolCall.function.arguments) ?? {},
                                    fn_args_buffer: toolCall.function.arguments,
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
                                id: toolCall.id,
                                fn_name: toolCall.function.name,
                                fn_args: safeJSON(toolCall.function.arguments) ?? {},
                                fn_args_buffer: toolCall.function.arguments,
                            },
                        }));
                        magmaStreamChunk.buffer.blocks.push(...bufferToolCallBlocks);
                    }

                    onStreamChunk?.(magmaStreamChunk);
                }

                let magmaMessage = new MagmaMessage({ role: 'assistant', blocks: [] });

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
                            id: toolCall.id,
                            fn_name: toolCall.function.name,
                            fn_args: safeJSON(toolCall.function.arguments) ?? {},
                            fn_args_buffer: toolCall.function.arguments,
                        },
                    }));
                    magmaMessage.blocks.push(...toolCallBlocks);
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'openai',
                    model: openAIConfig.model,
                    message: magmaMessage,
                    usage,
                    stop_reason: stopReason,
                };

                return magmaCompletion;
            } else {
                const openAICompletion = await openai.chat.completions.create(
                    {
                        ...openAIConfig,
                        stream: false,
                    },
                    { signal }
                );

                const choice = openAICompletion.choices[0];
                const openAIMessage = choice?.message;

                let magmaMessage = new MagmaMessage({ role: 'assistant', blocks: [] });

                if (openAIMessage?.content) {
                    magmaMessage.blocks.push({
                        type: 'text',
                        text: openAIMessage.content,
                    });
                }

                if (openAIMessage?.tool_calls) {
                    const toolCallBlocks: MagmaToolCallBlock[] = openAIMessage.tool_calls.map(
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
                    console.log(JSON.stringify(openAICompletion.choices[0], null, 2));
                    throw new Error('OpenAI completion was null');
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'openai',
                    model: openAICompletion.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens:
                            openAICompletion.usage.prompt_tokens -
                            (openAICompletion.usage.prompt_tokens_details.cached_tokens ?? 0),
                        output_tokens: openAICompletion.usage.completion_tokens,
                        cache_write_tokens: 0,
                        cache_read_tokens:
                            openAICompletion.usage.prompt_tokens_details.cached_tokens ?? 0,
                    },
                    stop_reason: this.convertStopReason(choice?.finish_reason),
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
    static override convertTools(tools: MagmaTool[]): OpenAITool[] | undefined {
        if (tools.length === 0) return undefined;
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
    static override convertConfig(config: MagmaCompletionConfig): ChatCompletionCreateParamsBase {
        let tool_choice = undefined;

        if (config.tool_choice === 'auto') tool_choice = 'auto';
        else if (config.tool_choice === 'required') tool_choice = 'required';
        else if (typeof config.tool_choice === 'string')
            tool_choice = { type: 'function', function: { name: config.tool_choice } };

        const { model, settings } = config.providerConfig as OpenAIProviderConfig;

        delete config.providerConfig;

        const openAIConfig: ChatCompletionCreateParamsBase = {
            ...config,
            model,
            messages: this.convertMessages(config.messages),
            tools: this.convertTools(config.tools),
            tool_choice: tool_choice,
            ...settings,
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
                        content: message.getText(),
                    });
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
                        openAIMessages.push({
                            role: 'assistant',
                            content: textWithReasoning,
                        });
                    }

                    if (toolCalls.length > 0) {
                        openAIMessages.push({
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
                            openAIMessages.push({
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
                        openAIMessages.push({
                            role: 'user',
                            content,
                        });
                    }
                    break;
            }
        }

        return openAIMessages;
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
            case 'content_filter':
                return 'content_filter';
            case 'length':
                return 'max_tokens';
            default:
                return 'unknown';
        }
    }
}
