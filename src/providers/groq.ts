import { MAX_RETRIES, Provider } from '.';
import {
    MagmaAssistantMessage,
    MagmaCompletion,
    MagmaCompletionStopReason,
    MagmaConfig,
    MagmaMessage,
    MagmaStreamChunk,
    MagmaTool,
    MagmaToolCallMessage,
    MagmaToolParam,
    MagmaUsage,
} from '../types';
import {
    ChatCompletionTool as GroqTool,
    ChatCompletionMessageParam as GroqMessageParam,
    ChatCompletionCreateParamsBase as GroqConfig,
    ChatCompletionChunk,
    ChatCompletion,
} from 'groq-sdk/resources/chat/completions';
import Groq from 'groq-sdk';
import { cleanParam, mapNumberInRange, sleep } from '../helpers';
import { Logger } from '../logger';

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
            max_tokens: config.max_tokens ?? undefined,
            tool_choice,
            temperature: config.temperature
                ? mapNumberInRange(config.temperature, 0, 1, 0, 2)
                : undefined,
        };

        return groqConfig;
    }

    static override async makeCompletionRequest(
        config: MagmaConfig,
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
                        magmaStreamChunk.usage = {
                            input_tokens: chunk.x_groq.usage.prompt_tokens,
                            output_tokens: chunk.x_groq.usage.completion_tokens,
                        };
                    }

                    if (delta?.tool_calls) {
                        magmaStreamChunk.delta.tool_calls = delta.tool_calls.map((toolCall) => ({
                            id: streamedToolCalls[toolCall.index].id,
                            name: toolCall.function.name,
                            arguments: toolCall.function.arguments,
                        }));
                    }

                    if (delta?.content) {
                        magmaStreamChunk.delta.content = delta.content;
                        contentBuffer += delta.content;
                    }

                    if (contentBuffer.length > 0) {
                        magmaStreamChunk.buffer.content = contentBuffer;
                    }

                    if (Object.keys(streamedToolCalls).length > 0) {
                        magmaStreamChunk.buffer.tool_calls = Object.values(streamedToolCalls).map(
                            (toolCall) => ({
                                id: toolCall.id,
                                fn_name: toolCall.function.name,
                                fn_args: toolCall.function.arguments,
                            })
                        );
                    }

                    onStreamChunk?.(magmaStreamChunk);
                }

                let magmaMessage: MagmaMessage;
                const toolCalls = Object.values(streamedToolCalls);
                if (toolCalls.length > 0) {
                    magmaMessage = {
                        role: 'tool_call',
                        tool_calls: toolCalls.map((toolCall) => ({
                            id: toolCall.id,
                            fn_name: toolCall.function.name,
                            fn_args: JSON.parse(toolCall.function.arguments),
                        })),
                        content: contentBuffer,
                    } as MagmaToolCallMessage;
                } else {
                    onStreamChunk?.(null);
                    magmaMessage = {
                        role: 'assistant',
                        content: contentBuffer,
                    } as MagmaAssistantMessage;
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'openai',
                    model: groqConfig.model,
                    message: magmaMessage,
                    usage,
                    stop_reason: stopReason,
                };

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

                let magmaMessage: MagmaMessage;

                if (groqMessage?.tool_calls) {
                    const groqToolCalls = groqMessage.tool_calls;

                    magmaMessage = {
                        role: 'tool_call',
                        tool_calls: groqToolCalls.map((tool_call) => ({
                            id: tool_call.id,
                            fn_name: tool_call.function.name,
                            fn_args: JSON.parse(tool_call.function.arguments),
                        })),
                    } as MagmaToolCallMessage;
                } else if (groqMessage?.content) {
                    magmaMessage = {
                        role: 'assistant',
                        content: groqMessage.content,
                    } as MagmaAssistantMessage;
                } else {
                    console.log(JSON.stringify(groqCompletion.choices[0], null, 2));
                    throw new Error('Groq completion was null');
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'groq',
                    model: groqCompletion.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: groqCompletion.usage.prompt_tokens,
                        output_tokens: groqCompletion.usage.completion_tokens,
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
                    let content: string | Array<any> = message.content;
                    if (message.images) {
                        const images = Array.isArray(message.images)
                            ? message.images
                            : [message.images];
                        content = [{ type: 'text', text: message.content }];

                        for (const image of images) {
                            if (typeof image === 'string') {
                                content.push({
                                    type: 'image_url',
                                    image_url: {
                                        url: image,
                                    },
                                });
                            } else {
                                content.push({
                                    type: 'image',
                                    image: {
                                        data: image.data,
                                        media_type: image.type,
                                    },
                                });
                            }
                        }
                    }
                    groqMessages.push({
                        role: 'user',
                        content,
                    });
                    break;
                case 'tool_call':
                    groqMessages.push({
                        role: 'assistant',
                        tool_calls: message.tool_calls.map((toolCall) => ({
                            type: 'function',
                            id: toolCall.id,
                            function: {
                                name: toolCall.fn_name,
                                arguments: JSON.stringify(toolCall.fn_args),
                            },
                        })),
                    });
                    break;
                case 'tool_result':
                    for (const tool_result of message.tool_results) {
                        groqMessages.push({
                            role: 'tool',
                            tool_call_id: tool_result.id,
                            content: tool_result.error
                                ? `Something went wrong calling your last tool - \n ${tool_result.result}`
                                : tool_result.result,
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
