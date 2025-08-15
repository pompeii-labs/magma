import { MagmaProviderConfig } from './providers';
import { MagmaMessage } from './messages';
import { MagmaTool } from './utilities/tools';

export type MagmaCompletionConfig = {
    providerConfig: MagmaProviderConfig;
    messages: MagmaMessage[];
    tools: MagmaTool[];
    stream?: boolean;
};

export type MagmaSendFunction = (message: Record<string, any>) => Promise<void> | void;
