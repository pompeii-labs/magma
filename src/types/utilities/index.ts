import { LanguageModelUsage } from 'ai';
import { MagmaHook } from './hooks';
import { MagmaJob } from './jobs';
import { MagmaMiddleware } from './middleware';
import { MagmaReceiver } from './receiver';
import { MagmaTool } from './tools';
import { MagmaSendFunction } from '../agent';
import { MagmaAgent } from '../../agent';

export * from './hooks';
export * from './jobs';
export * from './middleware';
export * from './tools';
export * from './receiver';

export type DecoratedExtras = {
    send: MagmaSendFunction;
    agent: MagmaAgent;
    ctx: Record<string, any>;
};

export type MagmaUtilities = {
    tools: MagmaTool[];
    middleware: MagmaMiddleware[];
    hooks: MagmaHook[];
    jobs: MagmaJob[];
    receivers: MagmaReceiver[];
};

export type MagmaUsage = LanguageModelUsage;
