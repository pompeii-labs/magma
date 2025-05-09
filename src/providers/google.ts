import {
    Content,
    FinishReason,
    FunctionCallingMode,
    FunctionDeclaration,
    FunctionDeclarationSchema,
    FunctionResponsePart,
    GoogleGenerativeAI,
    ModelParams,
    Part,
    Tool,
    ToolConfig,
} from '@google/generative-ai';
import { MAX_RETRIES, Provider } from '.';
import {
    GoogleProviderConfig,
    MagmaAssistantMessage,
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
                    cache_write_tokens: 0,
                    cache_read_tokens: 0,
                };

                const streamedToolCalls: {
                    id: string;
                    fn_name: string;
                    fn_args: Record<string, any>;
                    fn_args_buffer: string;
                }[] = [];

                let id = crypto.randomUUID();

                let stopReason: MagmaCompletionStopReason = null;

                for await (const chunk of stream) {
                    let magmaStreamChunk: MagmaStreamChunk = {
                        id,
                        provider: 'google',
                        model: googleConfig.model,
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

                    if (chunk.usageMetadata) {
                        magmaStreamChunk.usage.input_tokens = chunk.usageMetadata.promptTokenCount;
                        magmaStreamChunk.usage.output_tokens =
                            chunk.usageMetadata.candidatesTokenCount;
                    }

                    if (chunk.text().length > 0) {
                        magmaStreamChunk.delta.blocks.push({
                            type: 'text',
                            text: chunk.text(),
                        });
                        contentBuffer += chunk.text();
                    }

                    if (chunk.functionCalls()?.length > 0) {
                        for (const toolCall of chunk.functionCalls()) {
                            streamedToolCalls.push({
                                id: crypto.randomUUID(),
                                fn_name: toolCall.name,
                                fn_args: toolCall.args,
                                fn_args_buffer: JSON.stringify(toolCall.args),
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
                        magmaStreamChunk.buffer.blocks.push({
                            type: 'text',
                            text: contentBuffer,
                        });
                    }

                    for (const toolCall of streamedToolCalls) {
                        magmaStreamChunk.buffer.blocks.push({
                            type: 'tool_call',
                            tool_call: {
                                id: toolCall.id,
                                fn_name: toolCall.fn_name,
                                fn_args: toolCall.fn_args,
                                fn_args_buffer: toolCall.fn_args_buffer,
                            },
                        });
                    }

                    onStreamChunk?.(magmaStreamChunk);
                }

                let magmaMessage: MagmaMessage = new MagmaMessage({
                    role: 'assistant',
                    blocks: [],
                });

                for (const toolCall of streamedToolCalls) {
                    magmaMessage.blocks.push({
                        type: 'tool_call',
                        tool_call: {
                            id: toolCall.id,
                            fn_name: toolCall.fn_name,
                            fn_args: toolCall.fn_args,
                            fn_args_buffer: toolCall.fn_args_buffer,
                        },
                    });
                }

                if (contentBuffer.length > 0) {
                    magmaMessage.blocks.push({
                        type: 'text',
                        text: contentBuffer,
                    });
                }

                const magmaCompletion: MagmaCompletion = {
                    provider: 'google',
                    model: googleConfig.model,
                    message: magmaMessage,
                    usage,
                    stop_reason: stopReason,
                };

                onStreamChunk?.(null);

                return magmaCompletion;
            } else {
                const googleCompletion = await model.generateContent(
                    { contents: this.convertMessages(config.messages) },
                    {
                        signal,
                    }
                );

                let magmaMessage: MagmaMessage = new MagmaMessage({
                    role: 'assistant',
                    blocks: [],
                });

                const functionCalls = googleCompletion.response.functionCalls() ?? [];
                const text = googleCompletion.response.text();

                for (const toolCall of functionCalls) {
                    magmaMessage.blocks.push({
                        type: 'tool_call',
                        tool_call: {
                            id: crypto.randomUUID(),
                            fn_name: toolCall.name,
                            fn_args: toolCall.args,
                        },
                    });
                }

                if (text?.length > 0) {
                    magmaMessage.blocks.push({
                        type: 'text',
                        text,
                    });
                }

                if (magmaMessage.blocks.length === 0) {
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
                        cache_write_tokens: 0,
                        cache_read_tokens: 0,
                    },
                    stop_reason:
                        magmaMessage.getToolCalls().length > 0
                            ? 'tool_call'
                            : this.convertStopReason(
                                  googleCompletion.response.candidates[0]?.finishReason
                              ),
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

    // Tool schema to LLM function call converter
    static override convertTools(tools: MagmaTool[]): FunctionDeclaration[] | undefined {
        if (tools.length === 0) return undefined;

        const googleTools: FunctionDeclaration[] = [];

        for (const tool of tools) {
            const baseObject: MagmaToolParam = {
                type: 'object',
                properties: tool.params,
            };

            const parameters = cleanParam(baseObject, []) as FunctionDeclarationSchema;

            googleTools.push({
                name: tool.name,
                description: tool.description,
                parameters: Object.keys(parameters.properties).length > 0 ? parameters : undefined,
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
                .map((m) => m.getText())
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
                    let assistantParts: Part[] = [];
                    for (const block of message.blocks) {
                        switch (block.type) {
                            case 'text':
                                assistantParts.push({ text: block.text });
                                break;
                            case 'tool_call':
                                assistantParts.push({
                                    functionCall: {
                                        name: block.tool_call.fn_name,
                                        args: block.tool_call.fn_args,
                                    },
                                });
                                break;
                            case 'reasoning':
                                assistantParts.push({
                                    text: `<thinking>${block.reasoning}</thinking>`,
                                });
                                break;
                            default:
                                throw new Error(`Unsupported block type: ${block.type}`);
                        }
                    }
                    if (assistantParts.length > 0) {
                        googleMessages.push({
                            role: 'model',
                            parts: assistantParts,
                        });
                    }
                    break;
                case 'user':
                    let userParts: Part[] = [];
                    for (const block of message.blocks) {
                        switch (block.type) {
                            case 'text':
                                userParts.push({ text: block.text });
                                break;
                            case 'image':
                                userParts.push({
                                    inlineData: {
                                        data: block.image.data,
                                        mimeType: block.image.type,
                                    },
                                });
                                break;
                            case 'tool_result':
                                const resultPart: FunctionResponsePart = {
                                    functionResponse: {
                                        name: block.tool_result.fn_name,
                                        response: block.tool_result.error
                                            ? {
                                                  error: `Something went wrong calling your last tool - \n ${typeof block.tool_result.result !== 'string' ? JSON.stringify(block.tool_result.result) : block.tool_result.result}`,
                                              }
                                            : {
                                                  result:
                                                      typeof block.tool_result.result !== 'string'
                                                          ? JSON.stringify(block.tool_result.result)
                                                          : block.tool_result.result,
                                              },
                                    },
                                };
                                userParts.push(resultPart);
                                break;
                            default:
                                throw new Error(`Unsupported block type: ${block.type}`);
                        }
                    }

                    if (userParts.length > 0) {
                        googleMessages.push({
                            role: 'user',
                            parts: userParts,
                        });
                    }
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
