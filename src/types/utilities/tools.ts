import { MagmaState } from '../index';
import { MagmaToolCall } from '../messages';

export type MagmaToolParamType = 'string' | 'number' | 'object' | 'boolean' | 'array';

export type MagmaToolObjectParam = {
    type: 'object';
    description?: string;
    properties: (MagmaToolParam & { key: string; required?: boolean })[];
};

export type MagmaToolArrayParam = {
    type: 'array';
    description?: string;
    items: MagmaToolParam;
    limit?: number;
};

export type MagmaToolStringParam = {
    type: 'string';
    description?: string;
    enum?: string[];
};

export type MagmaToolNumberParam = {
    type: 'number';
    description?: string;
    enum?: number[];
};

export type MagmaToolBooleanParam = {
    type: 'boolean';
    description?: string;
};

export type MagmaToolParam =
    | MagmaToolObjectParam
    | MagmaToolArrayParam
    | MagmaToolStringParam
    | MagmaToolNumberParam
    | MagmaToolBooleanParam;

// Target in-code function that a MagmaTool maps to
export type MagmaToolTarget = (
    call: MagmaToolCall,
    state?: MagmaState
) => Promise<string | Record<string, any>> | string | Record<string, any>;
// Tool type containing the json schema sent to the LLM and the target to be called with the generated args
export type MagmaTool = {
    name: string;
    description: string;
    params: (MagmaToolParam & { key: string; required?: boolean })[];
    target: MagmaToolTarget;
    cache?: boolean;
};
