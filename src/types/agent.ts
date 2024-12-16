import { MagmaProviderConfig } from './providers';
import { MagmaMessage } from './messages';
import { MagmaTool } from './tools';

export type MagmaConfig = {
    providerConfig: MagmaProviderConfig;
    messages: MagmaMessage[];
    tools?: MagmaTool[];
    tool_choice?: 'auto' | 'required' | string;
    temperature?: number;
    stream?: boolean;
    max_tokens?: number;
};

export type MagmaState = Map<string, any>;
