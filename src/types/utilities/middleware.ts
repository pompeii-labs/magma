import {
    MagmaAssistantMessage,
    MagmaState,
    MagmaToolCall,
    MagmaToolResult,
    MagmaToolResultMessage,
    MagmaUserMessage,
} from '../index';

export const MagmaMiddlewareTriggers = [
    'onCompletion',
    'preCompletion',
    'onToolExecution',
    'preToolExecution',
] as const;

export type MagmaMiddlewareTriggerType = (typeof MagmaMiddlewareTriggers)[number];

export type MagmaMiddleware = {
    trigger: MagmaMiddlewareTriggerType;
    action: (
        message: MagmaUserMessage | MagmaAssistantMessage | MagmaToolCall | MagmaToolResult,
        state?: MagmaState
    ) => Promise<string | void> | string | void;
    name?: string;
};

export type MagmaMiddlewareReturnType<T extends MagmaMiddlewareTriggerType> =
    T extends 'preCompletion'
        ? string
        : T extends 'onCompletion'
          ? string
          : T extends 'preToolExecution'
            ? MagmaToolResultMessage
            : T extends 'onToolExecution'
              ? MagmaToolResultMessage
              : never;
