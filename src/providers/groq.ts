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
import { cleanParam, sleep } from '../helpers';
import { Logger } from '../logger';
import { safeJSON } from 'groq-sdk/core';

export class GroqProvider extends Provider {
    static override convertConfig(config: MagmaCompletionConfig): GroqConfig {
        let tool_choice = undefined;

        if (config.tool_choice === 'auto') tool_choice = 'auto';
        else if (config.tool_choice === 'required') tool_choice = 'required';
        else if (typeof config.tool_choice === 'string')
            tool_choice = { type: 'function', function: { name: config.tool_choice } };

        const { model, settings } = config.providerConfig as GroqProviderConfig;

        delete config.providerConfig;

        const groqConfig: GroqConfig = {
            ...config,
            model,
            messages: this.convertMessages(config.messages),
            tools: this.convertTools(config.tools),
            tool_choice,
            ...settings,
        };

        return groqConfig;
    }

    static override async makeCompletionRequest(
        config: MagmaCompletionConfig,
        onStreamChunk?: (chunk: MagmaStreamChunk | null) => Promise<void>,
        attempt: number = 0,
        signal?: AbortSignal
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
                    provider: 'groq',
                    model: groqConfig.model,
                    message: magmaMessage,
                    usage,
                    stop_reason: stopReason,
                };

                onStreamChunk?.(null);

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

                let magmaMessage = new MagmaMessage({ role: 'assistant', blocks: [] });

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
                    console.log(JSON.stringify(groqCompletion.choices[0], null, 2));
                    throw new Error('Groq completion was null');
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'groq',
                    model: groqConfig.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: groqCompletion.usage.prompt_tokens,
                        output_tokens: groqCompletion.usage.completion_tokens,
                        cache_write_tokens: 0,
                        cache_read_tokens: 0,
                    },
                    stop_reason: this.convertStopReason(choice?.finish_reason),
                };

                return magmaCompletion;
            }
        } catch (error) {
            if (signal?.aborted) {
                return null;
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

    static override convertTools(tools: MagmaTool[]): GroqTool[] | undefined {
        if (tools.length === 0) return undefined;

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
        const groqMessages: GroqMessageParam[] = [];

        for (const message of messages) {
            if ('id' in message) delete message.id;

            switch (message.role) {
                case 'system':
                    groqMessages.push({
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
