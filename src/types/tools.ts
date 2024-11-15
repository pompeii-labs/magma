import { MagmaState } from './index.js';
import { MagmaToolCall } from './messages.js';

export type MagmaToolParamType = 'string' | 'number' | 'object' | 'boolean' | 'array';

export type MagmaToolParam = {
    key?: string;
    type: MagmaToolParamType;
    description?: string;
    items?: MagmaToolParam;
    required?: boolean;
    enum?: string[] | number[];
    limit?: number;
    properties?: MagmaToolParam[];
};

export type MagmaToolSchema = {
    name: string;
    description?: string;
    properties: Record<string, MagmaToolParam>;
};

// Target in-code function that a MagmaTool maps to
export type MagmaToolTarget = (call: MagmaToolCall, state?: MagmaState) => Promise<string>;
// Tool type containing the json schema sent to the LLM and the target to be called with the generated args
export type MagmaTool = {
    name: string;
    description: string;
    params: MagmaToolParam[];
    target: MagmaToolTarget;
};
