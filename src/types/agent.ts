import { MagmaProviderConfig } from './providers.js';
import { MagmaMessage } from './messages.js';
import { MagmaTool } from './tools.js';

export type MagmaConfig = {
    providerConfig: MagmaProviderConfig;
    messages: MagmaMessage[];
    tools?: MagmaTool[];
    tool_choice?: 'auto' | 'required' | string;
    temperature?: number;
    stream?: boolean;
};

export type MagmaState = Map<string, any>;
