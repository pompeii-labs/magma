import {
    MagmaState,
    MagmaToolCall,
    MagmaToolResult,
} from '../index';

export const MagmaMiddlewareTriggers = [
    'onCompletion',
    'preCompletion',
    'onToolExecution',
    'preToolExecution',
] as const;

export type MagmaMiddlewareTriggerType = (typeof MagmaMiddlewareTriggers)[number];

export type MagmaMiddlewareReturnType<T extends MagmaMiddlewareTriggerType> =
    T extends 'preCompletion'
        ? string | void
        : T extends 'onCompletion'
          ? string | void
          : T extends 'preToolExecution'
            ? MagmaToolCall | void
            : T extends 'onToolExecution'
              ? MagmaToolResult | void
              : never;

export type MagmaMiddlewareParamType<T extends MagmaMiddlewareTriggerType> =
    T extends 'preToolExecution'
        ? MagmaToolCall
        : T extends 'onToolExecution'
          ? MagmaToolResult
          : T extends 'preCompletion'
            ? string
            : T extends 'onCompletion'
              ? string
              : never;

export type MagmaMiddleware = {
    trigger: MagmaMiddlewareTriggerType;
    action: (
        message: MagmaMiddlewareParamType<MagmaMiddlewareTriggerType>,
        state?: MagmaState
    ) =>
        | Promise<MagmaMiddlewareReturnType<MagmaMiddlewareTriggerType>>
        | MagmaMiddlewareReturnType<MagmaMiddlewareTriggerType>;
    name?: string;
};
