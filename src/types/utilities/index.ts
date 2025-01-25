import { MagmaHook } from './hooks';
import { MagmaJob } from './jobs';
import { MagmaMiddleware } from './middleware';
import { MagmaTool } from './tools';

export * from './hooks';
export * from './jobs';
export * from './middleware';
export * from './tools';

export type MagmaUtilities = {
    tools?: MagmaTool[];
    middleware?: MagmaMiddleware[];
    hooks?: MagmaHook[];
    jobs?: MagmaJob[];
};
