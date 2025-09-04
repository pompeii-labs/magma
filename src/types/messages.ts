import {
    AssistantModelMessage,
    ModelMessage,
    SystemModelMessage,
    TextStreamPart,
    Tool,
    ToolCallPart,
    ToolModelMessage,
    ToolResultPart,
    UserModelMessage,
} from 'ai';

export type MagmaToolCall = ToolCallPart;

export type MagmaToolResult = ToolResultPart;

export type MagmaStreamChunk = TextStreamPart<{
    [k: string]: Tool<unknown, never>;
}>;

export type MagmaMessage = ModelMessage;
export type MagmaUserMessage = UserModelMessage;
export type MagmaAssistantMessage = AssistantModelMessage;
export type MagmaSystemMessage = SystemModelMessage;
export type MagmaToolResultMessage = ToolModelMessage;
