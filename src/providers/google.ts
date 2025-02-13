import {
    Content,
    FinishReason,
    FunctionCallingMode,
    FunctionDeclaration,
    FunctionDeclarationSchema,
    GoogleGenerativeAI,
    ModelParams,
    Part,
    Tool,
    ToolConfig,
} from '@google/generative-ai';
import { MAX_RETRIES, Provider } from '.';
import {
    GoogleProviderConfig,
    MagmaCompletion,
    MagmaCompletionConfig,
    MagmaCompletionStopReason,
    MagmaMessage,
    MagmaStreamChunk,
    MagmaTool,
    MagmaToolParam,
    MagmaUsage,
} from '../types';
import { cleanParam, sleep } from '../helpers';
import { Logger } from '../logger';

export class GoogleProvider extends Provider {
    static override async makeCompletionRequest(
        config: MagmaCompletionConfig,
        onStreamChunk?: (chunk: MagmaStreamChunk | null) => Promise<void>,
        attempt: number = 0,
        signal?: AbortSignal
    ): Promise<MagmaCompletion> {
        try {
            const google = config.providerConfig.client as GoogleGenerativeAI;
            if (!google) throw new Error('Google instance not configured');

            const googleConfig = this.convertConfig(config);

            const model = google.getGenerativeModel(googleConfig);

            if (config.stream) {
                const { stream } = await model.generateContentStream(
                    { contents: this.convertMessages(config.messages) },
                    { signal }
                );
                let contentBuffer = '';
                const usage: MagmaUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                };

                const streamedToolCalls: {
                    id: string;
                    name: string;
                    arguments: Record<string, any>;
                }[] = [];

                let id = crypto.randomUUID();

                let stopReason: MagmaCompletionStopReason = null;

                for await (const chunk of stream) {
                    let magmaStreamChunk: MagmaStreamChunk = {
                        id,
                        provider: 'google',
                        model: googleConfig.model,
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

                    if (chunk.usageMetadata) {
                        magmaStreamChunk.usage.input_tokens = chunk.usageMetadata.promptTokenCount;
                        magmaStreamChunk.usage.output_tokens =
                            chunk.usageMetadata.candidatesTokenCount;
                    }

                    if (chunk.text().length > 0) {
                        magmaStreamChunk.delta.content = chunk.text();
                        contentBuffer += chunk.text();
                    }

                    if (chunk.functionCalls()?.length > 0) {
                        for (const toolCall of chunk.functionCalls()) {
                            streamedToolCalls.push({
                                id: crypto.randomUUID(),
                                name: toolCall.name,
                                arguments: toolCall.args,
                            });
                        }
                    }

                    if (chunk.candidates[0]?.finishReason) {
                        if (streamedToolCalls.length > 0) {
                            stopReason = 'tool_call';
                        } else {
                            stopReason = this.convertStopReason(chunk.candidates[0].finishReason);
                        }
                        magmaStreamChunk.stop_reason = stopReason;
                    }

                    if (contentBuffer.length > 0) {
                        magmaStreamChunk.buffer.content = contentBuffer;
                    }

                    if (streamedToolCalls.length > 0) {
                        magmaStreamChunk.buffer.tool_calls = streamedToolCalls.map((toolCall) => ({
                            id: toolCall.id,
                            name: toolCall.name,
                            arguments: JSON.stringify(toolCall.arguments),
                        }));
                    }

                    onStreamChunk?.(magmaStreamChunk);
                }

                onStreamChunk?.(null);
                let magmaMessage: MagmaMessage;
                if (streamedToolCalls.length > 0) {
                    // Convert the arguments buffer to an object
                    magmaMessage = {
                        role: 'tool_call',
                        tool_calls: streamedToolCalls.map((toolCall) => ({
                            id: toolCall.id,
                            fn_name: toolCall.name,
                            fn_args: toolCall.arguments,
                        })),
                    };
                    if (contentBuffer.length > 0) {
                        magmaMessage.content = contentBuffer;
                    }
                } else {
                    magmaMessage = { role: 'assistant', content: contentBuffer };
                }
                const magmaCompletion: MagmaCompletion = {
                    provider: 'google',
                    model: googleConfig.model,
                    message: magmaMessage,
                    usage,
                    stop_reason: stopReason,
                };

                return magmaCompletion;
            } else {
                const googleCompletion = await model.generateContent(
                    { contents: this.convertMessages(config.messages) },
                    {
                        signal,
                    }
                );

                let magmaMessage: MagmaMessage;

                const functionCalls = googleCompletion.response.functionCalls();
                const text = googleCompletion.response.text();

                if (functionCalls?.length > 0) {
                    magmaMessage = {
                        role: 'tool_call',
                        tool_calls: functionCalls.map((toolCall) => ({
                            id: crypto.randomUUID(),
                            fn_name: toolCall.name,
                            fn_args: toolCall.args,
                        })),
                    };

                    if (text?.length > 0) {
                        magmaMessage.content = text;
                    }
                } else if (text?.length > 0) {
                    magmaMessage = { role: 'assistant', content: text };
                } else {
                    console.log(JSON.stringify(googleCompletion.response, null, 2));
                    throw new Error('Google completion was null');
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'google',
                    model: googleConfig.model,
                    message: magmaMessage,
                    usage: {
                        input_tokens: googleCompletion.response.usageMetadata.promptTokenCount,
                        output_tokens: googleCompletion.response.usageMetadata.candidatesTokenCount,
                    },
                    stop_reason:
                        magmaMessage.role === 'tool_call'
                            ? 'tool_call'
                            : this.convertStopReason(
                                  googleCompletion.response.candidates[0]?.finishReason
                              ),
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
    static override convertTools(tools: MagmaTool[]): FunctionDeclaration[] | undefined {
        if (tools.length === 0) return undefined;

        const googleTools: FunctionDeclaration[] = [];

        for (const tool of tools) {
            const baseObject: MagmaToolParam = {
                type: 'object',
                properties: tool.params,
            };

            googleTools.push({
                name: tool.name,
                description: tool.description,
                parameters: cleanParam(baseObject, []) as FunctionDeclarationSchema,
            });
        }

        return googleTools;
    }

    // MagmaConfig to Provider-specific config converter
    static override convertConfig(config: MagmaCompletionConfig): ModelParams {
        const functionDeclarations: FunctionDeclaration[] = this.convertTools(config.tools);

        let toolConfig: ToolConfig = {
            functionCallingConfig: {
                mode: FunctionCallingMode.MODE_UNSPECIFIED,
            },
        };

        if (config.tool_choice === 'auto')
            toolConfig.functionCallingConfig.mode = FunctionCallingMode.AUTO;
        else if (config.tool_choice === 'required')
            toolConfig.functionCallingConfig.mode = FunctionCallingMode.ANY;
        else if (typeof config.tool_choice === 'string') {
            toolConfig.functionCallingConfig.mode = FunctionCallingMode.ANY;
            toolConfig.functionCallingConfig.allowedFunctionNames = [config.tool_choice];
        }

        const tools: Tool[] = [];

        functionDeclarations &&
            tools.push({
                functionDeclarations,
            });

        const { model, settings } = config.providerConfig as GoogleProviderConfig;

        const googleConfig: ModelParams = {
            model,
            tools,
            toolConfig,
            systemInstruction: config.messages
                .filter((m) => m.role === 'system')
                .map((m) => m.content)
                .join('\n'),
            generationConfig: settings,
        };

        return googleConfig;
    }

    // MagmaMessage to Provider-specific message converter
    static override convertMessages(messages: MagmaMessage[]): Content[] {
        const googleMessages: Content[] = [];

        for (const message of messages) {
            if ('id' in message) delete message.id;

            switch (message.role) {
                case 'system':
                    continue;
                case 'assistant':
                    googleMessages.push({
                        role: 'model',
                        parts: [{ text: message.content }],
                    });
                    break;
                case 'user':
                    let parts: Part[] = [{ text: message.content }];
                    if (message.images) {
                        const images = Array.isArray(message.images)
                            ? message.images
                            : [message.images];

                        for (const image of images) {
                            // If image is a string, it is a url
                            if (typeof image === 'string') {
                                throw new Error('Image URLs are not supported by Google');
                            } else {
                                parts.push({
                                    inlineData: {
                                        data: image.data,
                                        mimeType: image.type,
                                    },
                                });
                            }
                        }
                    }

                    googleMessages.push({
                        role: 'user',
                        parts,
                    });
                    break;
                case 'tool_call':
                    const toolCalls = message.tool_calls;
                    googleMessages.push({
                        role: 'model',
                        parts: toolCalls.map((toolCall) => ({
                            functionCall: {
                                name: toolCall.fn_name,
                                args: toolCall.fn_args,
                            },
                        })),
                    });
                    break;
                case 'tool_result':
                    googleMessages.push({
                        role: 'model',
                        parts: message.tool_results.map((toolResult) => ({
                            functionResponse: {
                                name: toolResult.fn_name,
                                response: toolResult.error
                                    ? {
                                          error: `Something went wrong calling your last tool - \n ${typeof toolResult.result !== 'string' ? JSON.stringify(toolResult.result) : toolResult.result}`,
                                      }
                                    : {
                                          result:
                                              typeof toolResult.result !== 'string'
                                                  ? JSON.stringify(toolResult.result)
                                                  : toolResult.result,
                                      },
                            },
                        })),
                    });
                    break;
            }
        }

        if (googleMessages.length === 0) {
            googleMessages.unshift({
                role: 'user',
                parts: [{ text: 'begin' }],
            });
        }

        return googleMessages;
    }

    static override convertStopReason(stop_reason: FinishReason): MagmaCompletionStopReason {
        switch (stop_reason) {
            case FinishReason.RECITATION:
            case FinishReason.STOP:
                return 'natural';
            case FinishReason.MAX_TOKENS:
                return 'max_tokens';
            case FinishReason.SAFETY:
                return 'content_filter';
            case FinishReason.LANGUAGE:
                return 'unsupported';
            default:
                return 'unknown';
        }
    }
}
