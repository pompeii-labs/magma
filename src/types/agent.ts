import { MagmaProviderConfig } from './providers';
import { MagmaMessage } from './messages';
import { MagmaTool } from './utilities/tools';

export type MagmaCompletionConfig = {
    providerConfig: MagmaProviderConfig;
    messages: MagmaMessage[];
    tools: MagmaTool[];
    tool_choice?: 'auto' | 'required' | (string & {});
    stream?: boolean;
};
