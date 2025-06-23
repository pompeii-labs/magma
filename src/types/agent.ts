import { MagmaProviderConfig } from './providers';
import { MagmaMessage } from './messages';
import { MagmaTool } from './utilities/tools';

export type MagmaCompletionConfig = {
    providerConfig: MagmaProviderConfig;
    messages: MagmaMessage[];
    tools: MagmaTool[];
    stream?: boolean;
};
