import { Request, Response } from 'express';
import { MagmaAgent } from '../../agent';

export type MagmaHook = {
    name: string;
    handler: (request: Request, response: Response, agent: MagmaAgent) => Promise<void>;
    session?: 'default' | (string & {}) | ((req: Request) => string | Promise<string>);
    setup?: ((req: Request) => Record<string, any> | Promise<Record<string, any>>) | Record<string, any>;
    description?: string;
};
