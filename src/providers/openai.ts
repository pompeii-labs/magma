import OpenAI from 'openai';
import { MAX_RETRIES, Provider } from '.';
import {
    MagmaAssistantMessage,
    MagmaCompletion,
    MagmaConfig,
    MagmaMessage,
    MagmaStreamChunk,
    MagmaTool,
    MagmaToolCallMessage,
    MagmaToolParam,
    MagmaUsage,
} from '../types';
import { Logger } from '../logger';
import {
    ChatCompletionMessageParam as OpenAIMessageParam,
    ChatCompletionTool as OpenAITool,
} from 'openai/resources/index';
import { cleanParam, mapNumberInRange, sleep } from '../helpers';
import {
    ChatCompletionChunk,
    ChatCompletionCreateParamsBase,
} from 'openai/resources/chat/completions';

export class OpenAIProvider extends Provider {
    static override async makeCompletionRequest(
        config: MagmaConfig,
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
                };

                let streamedToolCalls: {
                    [index: number]: ChatCompletionChunk.Choice.Delta.ToolCall;
                } = {};

                for await (const chunk of stream) {
                    let magmaStreamChunk: MagmaStreamChunk = {
                        id: chunk.id,
                        provider: 'openai',
                        model: chunk.model,
                        delta: {
                            tool_calls: null,
                            content: null,
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

                    const delta = chunk.choices[0]?.delta;

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
                        usage.input_tokens = chunk.usage.prompt_tokens;
                        usage.output_tokens = chunk.usage.completion_tokens;
                        magmaStreamChunk.usage = {
                            input_tokens: chunk.usage.prompt_tokens,
                            output_tokens: chunk.usage.completion_tokens,
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
                    model: openAIConfig.model,
                    message: magmaMessage,
                    usage,
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

                const openAIMessage = openAICompletion.choices[0].message;

                let magmaMessage: MagmaMessage;

                if (openAIMessage.tool_calls) {
                    const openaiToolCalls = openAIMessage.tool_calls;

                    magmaMessage = {
                        role: 'tool_call',
                        tool_calls: openaiToolCalls.map((tool_call) => ({
                            id: tool_call.id,
                            fn_name: tool_call.function.name,
                            fn_args: JSON.parse(tool_call.function.arguments),
                        })),
                    } as MagmaToolCallMessage;
                } else if (openAIMessage.content) {
                    magmaMessage = {
                        role: 'assistant',
                        content: openAIMessage.content,
                    } as MagmaAssistantMessage;
                } else {
                    console.log(JSON.stringify(openAICompletion.choices[0], null, 2));
                    throw new Error('OpenAI completion was null');
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
            tools,
            max_tokens: config.max_tokens ?? undefined,
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
                    let content: string | Array<any> = message.content;
                    if (message.images) {
                        const images = Array.isArray(message.images)
                            ? message.images
                            : [message.images];
                        content = [{ type: 'text', text: message.content }];

                        for (const image of images) {
                            // If image is a string, it is a url
                            if (typeof image === 'string') {
                                content.push({
                                    type: 'image_url',
                                    image_url: {
                                        url: image,
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
                    }

                    openAIMessages.push({
                        role: 'user',
                        content,
                    });
                    break;
                case 'tool_call':
                    openAIMessages.push({
                        role: 'assistant',
                        tool_calls: message.tool_calls.map((tool_call) => ({
                            type: 'function',
                            id: tool_call.id,
                            function: {
                                name: tool_call.fn_name,
                                arguments: JSON.stringify(tool_call.fn_args),
                            },
                        })),
                    });
                    break;
                case 'tool_result':
                    for (const tool_result of message.tool_results) {
                        openAIMessages.push({
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

        return openAIMessages;
    }
}
