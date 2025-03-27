import { Request, Response } from 'express';
import { MagmaAgent } from '../../agent';

export function extractPathFromHookRequest(request: Request, path?: string): any {
    if (!path) return undefined;

    if (!path.includes('.')) return path;

    // Handle nested paths
    return path.split('.').reduce((obj, key) => obj?.[key], request);
}

export type MagmaHook = {
    name: string;
    handler: (request: Request, response: Response, agent: MagmaAgent) => Promise<void>;
    session?:
        | { path: string; id?: undefined }
        | { path?: undefined; id: 'default' | (string & {}) };
};
