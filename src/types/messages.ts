import { MagmaProvider } from './providers.js';

export type MagmaCompletion = {
    message: MagmaMessage;
    provider: MagmaProvider;
    model: string;
    usage: MagmaUsage;
};

export type MagmaUsage = {
    input_tokens: number;
    output_tokens: number;
};

// Provider-agnostic message type
export type MagmaMessage =
    | MagmaSystemMessage
    | MagmaAssistantMessage
    | MagmaUserMessage
    | MagmaToolCall
    | MagmaToolResult;

export type MagmaSystemMessage = {
    id?: string | number;
    role: 'system';
    content: string;
};

export type MagmaUserMessage = {
    id?: string | number;
    role: 'user';
    content: string;
};

export type MagmaAssistantMessage = {
    id?: string | number;
    role: 'assistant';
    content: string;
};

// Provider-agnostic tool/function type
export type MagmaToolCall = {
    role: 'tool_call';
    tool_call_id: string;
    fn_name: string;
    fn_args: Record<string, any>;
};

export type MagmaToolResult = {
    role: 'tool_result';
    tool_result_id: string;
    tool_result: string;
    tool_result_error?: boolean;
};

export type MagmaStreamChunk = {
    id?: string;
    provider: MagmaProvider;
    model: string;
    delta: {
        role?: 'assistant' | 'tool_call';
        content?: string;
        tool_call?: {
            id?: string;
            name?: string;
            arguments?: string;
        };
    };
    buffer?: string;
    reason?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
};
