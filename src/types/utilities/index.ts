import { LanguageModelUsage } from 'ai';
import { MagmaHook } from './hooks';
import { MagmaJob } from './jobs';
import { MagmaMiddleware } from './middleware';
import { MagmaReceiver } from './receiver';
import { MagmaTool } from './tools';

export * from './hooks';
export * from './jobs';
export * from './middleware';
export * from './tools';
export * from './receiver';

export type MagmaUtilities = {
    tools: MagmaTool[];
    middleware: MagmaMiddleware[];
    hooks: MagmaHook[];
    jobs: MagmaJob[];
    receivers: MagmaReceiver[];
};

export type MagmaUsage = LanguageModelUsage;
