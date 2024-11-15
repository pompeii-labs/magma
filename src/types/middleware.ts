import { MagmaState } from './index';

export const MagmaMiddlewareTriggers = [
    'onCompletion',
    'preCompletion',
    'onToolExecution',
    'preToolExecution',
] as const;

export type MagmaMiddlewareTriggerType = (typeof MagmaMiddlewareTriggers)[number];

export type MagmaMiddlewareTriggerTypeArgsMap<T extends MagmaMiddlewareTriggerType> =
    T extends 'onCompletion'
        ? any // Generated message
        : T extends 'onToolExecution'
          ? { call: any; result: any }
          : T extends 'preCompletion'
            ? any // User's message
            : any; // Tool call

export type MagmaMiddleware = {
    trigger: MagmaMiddlewareTriggerType;
    action: (args: any, state?: MagmaState) => Promise<string | void>;
};
