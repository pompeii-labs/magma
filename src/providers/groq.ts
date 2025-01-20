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
import {
    ChatCompletionTool as GroqTool,
    ChatCompletionMessageParam as GroqMessageParam,
    ChatCompletionCreateParamsBase as GroqConfig,
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
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
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

                    if (chunk.x_groq?.usage) {
                        usage.input_tokens = chunk.x_groq.usage.prompt_tokens ?? 0;
                        usage.output_tokens = chunk.x_groq.usage.completion_tokens ?? 0;
                        continue;
                    }

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
                            provider: 'groq',
                            model: groqConfig.model,
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
                    provider: 'groq',
                    model: groqConfig.model,
                    message: magmaMessage,
                    usage,
                };

                return magmaCompletion;
            } else {
                const groqCompletion = (await groq.chat.completions.create(groqConfig, {
                    signal,
                })) as ChatCompletion;

                const groqMessage = groqCompletion.choices[0].message;

                let magmaMessage: MagmaMessage;

                if (groqMessage.tool_calls) {
                    const tool_call = groqMessage.tool_calls[0];
                    magmaMessage = {
                        role: 'tool_call',
                        tool_call_id: tool_call.id,
                        fn_name: tool_call.function.name,
                        fn_args: JSON.parse(tool_call.function.arguments),
                    };
                } else {
                    magmaMessage = { role: 'assistant', content: groqMessage.content };
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'groq',
                    model: groqCompletion.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: groqCompletion.usage.prompt_tokens,
                        output_tokens: groqCompletion.usage.completion_tokens,
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
                    groqMessages.push({
                        role: 'tool',
                        tool_call_id: message.tool_result_id,
                        content: message.tool_result_error
                            ? `Something went wrong calling your last tool - \n ${message.tool_result}`
                            : message.tool_result,
                    });
                    break;
            }
        }

        return groqMessages;
    }
}
