import { MagmaProvider } from './providers';

export type MagmaCompletionStopReason =
    | 'natural'
    | 'tool_call'
    | 'content_filter'
    | 'max_tokens'
    | 'unsupported'
    | 'unknown';

export type MagmaCompletion = {
    message: MagmaAssistantMessage | MagmaToolCallMessage | MagmaToolResultMessage;
    provider: MagmaProvider;
    model: string;
    usage: MagmaUsage;
    stop_reason: MagmaCompletionStopReason;
};

export type MagmaUsage = {
    input_tokens: number;
    output_tokens: number;
};

export type MagmaImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type MagmaImage = {
    data: string;
    type: MagmaImageType;
};

// Provider-agnostic message type
export type MagmaMessage =
    | MagmaSystemMessage
    | MagmaAssistantMessage
    | MagmaUserMessage
    | MagmaToolCallMessage
    | MagmaToolResultMessage;

export type MagmaSystemMessage = {
    id?: string | number;
    role: 'system';
    content: string;
};

export type MagmaUserMessage = {
    id?: string | number;
    role: 'user';
    content: string;
    images?: string[] | MagmaImage[];
};

export type MagmaAssistantMessage = {
    id?: string | number;
    role: 'assistant';
    content: string;
};

// Provider-agnostic tool/function type
export type MagmaToolCall = {
    id: string;
    fn_name: string;
    fn_args: Record<string, any>;
};

export type MagmaToolResult = {
    id: string;
    result: string;
    error?: boolean;
    fn_name: string;
};

export type MagmaToolCallMessage = {
    role: 'tool_call';
    content?: string;
    tool_calls: MagmaToolCall[];
};

export type MagmaToolResultMessage = {
    role: 'tool_result';
    tool_results: MagmaToolResult[];
};

export type MagmaStreamChunk = {
    id: string;
    provider: MagmaProvider;
    model: string;
    delta: {
        content: string | null;
        tool_calls:
            | {
                  id?: string;
                  name?: string;
                  arguments?: string;
              }[]
            | null;
    };
    buffer: {
        content: string | null;
        tool_calls:
            | {
                  id?: string;
                  name?: string;
                  arguments?: string;
              }[]
            | null;
    };
    stop_reason: MagmaCompletionStopReason;
    usage: {
        input_tokens: number | null;
        output_tokens: number | null;
    };
};
