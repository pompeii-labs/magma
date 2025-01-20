import {
    Content,
    DynamicRetrievalMode,
    FunctionCallingMode,
    FunctionDeclaration,
    FunctionDeclarationSchema,
    FunctionDeclarationSchemaProperty,
    GoogleGenerativeAI,
    InlineDataPart,
    ModelParams,
    Part,
    SchemaType,
    Tool,
    ToolConfig,
} from '@google/generative-ai';
import { MAX_RETRIES, Provider } from '.';
import {
    GoogleProviderConfig,
    MagmaCompletion,
    MagmaConfig,
    MagmaMessage,
    MagmaStreamChunk,
    MagmaTool,
    MagmaToolParam,
    MagmaUsage,
} from '../types';
import { cleanParam, mapNumberInRange, sleep } from '../helpers';
import { Logger } from '../logger';

export class GoogleProvider extends Provider {
    static override async makeCompletionRequest(
        config: MagmaConfig,
        onStreamChunk?: (chunk?: MagmaStreamChunk) => Promise<void>,
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
                let buffer = '';
                const usage: MagmaUsage = {
                    input_tokens: 0,
                    output_tokens: 0,
                };

                const streamedToolCalls: {
                    id: string;
                    name: string;
                    arguments: Record<string, any>;
                }[] = [];

                for await (const chunk of stream) {
                    console.log(JSON.stringify(chunk, null, 2));
                    // First stream chunk telling us what tools are being called
                    if (chunk.functionCalls()?.length > 0) {
                        for (const toolCall of chunk.functionCalls()) {
                            streamedToolCalls.push({
                                id: crypto.randomUUID(),
                                name: toolCall.name,
                                arguments: {},
                            });
                        }
                    }
                    if (chunk.usageMetadata) {
                        usage.input_tokens = chunk.usageMetadata.promptTokenCount;
                        usage.output_tokens = chunk.usageMetadata.candidatesTokenCount;
                        continue;
                    }
                    if (onStreamChunk) {
                        const delta = chunk;
                        buffer += delta.text() ?? '';
                        const magmaChunk: MagmaStreamChunk = {
                            id: crypto.randomUUID(),
                            provider: 'google',
                            model: googleConfig.model,
                            delta: {
                                content:
                                    delta.functionCalls()?.length > 0
                                        ? delta.functionCalls().toString()
                                        : delta.text(),
                                role: delta.functionCalls()?.length > 0 ? 'tool_call' : 'assistant',
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
                    provider: 'google',
                    model: googleConfig.model,
                    message: magmaMessage,
                    usage,
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

                if (googleCompletion.response.functionCalls()) {
                    const googleToolCalls = googleCompletion.response.functionCalls();

                    if (googleToolCalls.length === 1) {
                        const tool_call = googleToolCalls[0];

                        magmaMessage = {
                            role: 'tool_call',
                            tool_call_id: crypto.randomUUID(),
                            fn_name: tool_call.name,
                            fn_args: tool_call.args,
                        };
                    }
                } else if (googleCompletion.response.text()) {
                    magmaMessage = { role: 'assistant', content: googleCompletion.response.text() };
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
    static override convertTools(tools: MagmaTool[]): FunctionDeclaration[] {
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
    static override convertConfig(config: MagmaConfig): ModelParams {
        const functionDeclarations: FunctionDeclaration[] | undefined = config.tools
            ? this.convertTools(config.tools)
            : undefined;

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

        const model = config.providerConfig.model;

        const googleConfig: ModelParams = {
            model,
            tools,
            toolConfig,
            systemInstruction: config.messages
                .filter((m) => m.role === 'system')
                .map((m) => m.content)
                .join('\n'),
            generationConfig: {
                maxOutputTokens: config.max_tokens,
                temperature: config.temperature,
            },
        };

        console.log(JSON.stringify(googleConfig, null, 2));

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
                    googleMessages.push({
                        role: 'model',
                        parts: [
                            {
                                functionCall: {
                                    name: message.fn_name,
                                    args: message.fn_args,
                                },
                            },
                        ],
                    });
                    break;
                case 'tool_result':
                    googleMessages.push({
                        role: 'model',
                        parts: [
                            {
                                functionResponse: {
                                    name: message.fn_name,
                                    response: message.tool_result_error
                                        ? {
                                              error: `Something went wrong calling your last tool - \n ${message.tool_result}`,
                                          }
                                        : { result: message.tool_result },
                                },
                            },
                        ],
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
}
