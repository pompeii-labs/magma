import { MagmaAgent } from '../../agent';
import { MagmaToolCall, MagmaToolResult } from '../index';

export const MagmaMiddlewareTriggers = [
    'onCompletion',
    'preCompletion',
    'onToolExecution',
    'preToolExecution',
    'onMainFinish',
    'postProcess'
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
              : T extends 'onMainFinish'
                ? string | void
                : T extends 'postProcess'
                  ? string | void
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
              : T extends 'onMainFinish'
                ? string
                : T extends 'postProcess'
                  ? string
                  : never;

export type MagmaMiddleware = {
    trigger: MagmaMiddlewareTriggerType;
    action: (
        message: MagmaMiddlewareParamType<MagmaMiddlewareTriggerType>,
        agent: MagmaAgent
    ) =>
        | Promise<MagmaMiddlewareReturnType<MagmaMiddlewareTriggerType>>
        | MagmaMiddlewareReturnType<MagmaMiddlewareTriggerType>;
    name?: string;
    critical?: boolean;
    order?: number;
};
