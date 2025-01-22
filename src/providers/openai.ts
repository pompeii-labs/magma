import OpenAI from 'openai';
import { MAX_RETRIES, Provider } from '.';
import {
    MagmaCompletion,
    MagmaConfig,
    MagmaMessage,
    MagmaStreamChunk,
    MagmaTool,
    MagmaToolParam,
    MagmaUsage,
} from '../types';
import { ChatCompletion } from 'openai/resources';
import { Logger } from '../logger';
import {
    ChatCompletionMessageParam as OpenAIMessageParam,
    ChatCompletionTool as OpenAITool,
} from 'openai/resources/index';
import { cleanParam, mapNumberInRange, sleep } from '../helpers';
import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';

export class OpenAIProvider extends Provider {
    static override async makeCompletionRequest(
        config: MagmaConfig,
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
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
                    const openaiToolCalls = openAIMessage.tool_calls;

                    if (openaiToolCalls.length === 1) {
                        const tool_call = openaiToolCalls[0];

                        magmaMessage = {
                            role: 'tool_call',
                            tool_call_id: tool_call.id,
                            fn_name: tool_call.function.name,
                            fn_args: JSON.parse(tool_call.function.arguments),
                        };
                    } else {
                        magmaMessage = {
                            role: 'multi_tool_call',
                            tool_calls: openaiToolCalls.map((tool_call) => ({
                                role: 'tool_call',
                                tool_call_id: tool_call.id,
                                fn_name: tool_call.function.name,
                                fn_args: JSON.parse(tool_call.function.arguments),
                            })),
                        };
                    }
                } else if (openAIMessage.content) {
                    magmaMessage = { role: 'assistant', content: openAIMessage.content };
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
                case 'multi_tool_call':
                    openAIMessages.push({
                        role: 'assistant',
                        tool_calls: message.tool_calls.map((tool_call) => ({
                            type: 'function',
                            id: tool_call.tool_call_id,
                            function: {
                                name: tool_call.fn_name,
                                arguments: JSON.stringify(tool_call.fn_args),
                            },
                        })),
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
                case 'multi_tool_result':
                    for (const toolResult of message.tool_results) {
                        openAIMessages.push({
                            role: 'tool',
                            tool_call_id: toolResult.tool_result_id,
                            content: toolResult.tool_result_error
                                ? `Something went wrong calling ${toolResult.tool_result_id} - \n ${toolResult.tool_result}`
                                : toolResult.tool_result,
                        });
                    }
                    break;
            }
        }

        return openAIMessages;
    }
}
