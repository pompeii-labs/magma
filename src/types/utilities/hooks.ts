import { Request, Response } from 'express';
import { MagmaAgent } from '../../agent';

export function extractPathFromHookRequest(request: Request, path?: string): any {
    if (!path) return undefined;

    // Handle nested paths
    return path.split('.').reduce((obj, key) => obj?.[key], request);
}

export type MagmaHook = {
    name: string;
    handler: (request: Request, response: Response, agent: MagmaAgent) => Promise<void>;
    session?: { path: string };
};
