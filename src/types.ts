/* PROVIDERS */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ChatModel } from "openai/resources/index.mjs";

export const MagmaProviders = ['openai', 'anthropic'] as const;
export type MagmaProvider = (typeof MagmaProviders)[number];

export type MagmaClient = OpenAI | Anthropic;

export type AnthropicModel = Anthropic.Messages.Model;

export type OpenAIModel = ChatModel;
    
export type MagmaModel = AnthropicModel | OpenAIModel;

export type MagmaProviderConfig = {
    client: MagmaClient;
    model: MagmaModel;
};

export type MagmaToolSchema = {
    name: string;
    description?: string;
    properties: Record<string, MagmaToolParam>;
};

export type MagmaConfig = {
    model: MagmaModel;
    messages: MagmaMessage[];
    tools?: MagmaTool[];
    tool_choice?: 'auto' | 'required' | string;
    temperature?: number;
};

/* TOOLS  */

// Converted to one of the arguments generated in a tool call
export type MagmaToolParam = {
    key?: string;
    type: MagmaToolParamType;
    description?: string;
    items?: MagmaToolParam;
    required?: boolean;
    enum?: string[];
    limit?: number;
    properties?: MagmaToolParam[];
};
// Type of the tool/function call argument
export type MagmaToolParamType = 'string' | 'number' | 'object' | 'boolean' | 'array';

// Target in-code function that a MagmaTool maps to
export type MagmaToolTarget = (args: Record<string, any>, state?: State) => Promise<string>;
// Tool type containing the json schema sent to the LLM and the target to be called with the generated args
export type MagmaTool = {
    name: string;
    description: string;
    params: MagmaToolParam[];
    target: MagmaToolTarget;
};

/* MIDDLEWARE */

// Types of trigger events for middleware
export const MagmaMiddlewareTriggers = [
    'onCompletion',
    'preCompletion',
    'onToolExecution',
    'preToolExecution',
] as const;
// Middleware trigger type
export type MagmaMiddlewareTriggerType = (typeof MagmaMiddlewareTriggers)[number];
export type MagmaMiddlewareTriggerTypeArgsMap<T extends MagmaMiddlewareTriggerType> = T extends 'onCompletion'
    ? any // Generated message
    : T extends 'onToolExecution'
      ? { call: any; result: any }
      : T extends 'preCompletion'
        ? any // User's message
        : any; // Tool call
// Middleware container type with trigger and target action
export type MagmaMiddleware = {
    trigger: MagmaMiddlewareTriggerType;
    action: (args: any, state?: State) => Promise<string | void>;
};

/* MISC */

// Provider-agnost completion type
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
    role: 'system';
    content: string;
};

export type MagmaUserMessage = {
    role: 'user';
    content: string;
};

export type MagmaAssistantMessage = {
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

// agent state / scratchpad
export type State = Map<string, any>;
