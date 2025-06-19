import { Request, Response } from 'express';
import { MagmaAgent } from './agent';
import {
    MagmaToolParam,
    MagmaMiddlewareTriggerType,
    MagmaMiddlewareTriggers,
    MagmaMiddlewareParamType,
    MagmaMiddlewareReturnType,
    MagmaToolCall,
    MagmaToolReturnType,
    MagmaHook,
} from './types';
import { validate } from 'node-cron';

/**
 * Decorator to define a tool (optional)
 * @param args name and description for tool
 */
export function tool(args: {
    name?: string;
    description?: string;
    cache?: boolean;
    enabled?: (agent: MagmaAgent) => boolean;
}) {
    return function <R extends MagmaToolReturnType | Promise<MagmaToolReturnType>>(
        target: object,
        propertyKey: string,
        descriptor: TypedPropertyDescriptor<
            ((call: MagmaToolCall, agent: MagmaAgent) => R) & {
                _toolInfo?: {
                    name?: string;
                    description?: string;
                    cache?: boolean;
                    enabled?: (agent: MagmaAgent) => boolean;
                };
            }
        >
    ) {
        descriptor.value._toolInfo = {
            name: args.name ?? propertyKey,
            description: args.description,
            cache: args.cache,
            enabled: args.enabled,
        };
    };
}

/**
 * Decorator for functions that are exposed to OpenAI tool calls
 * @param key name of the parameter
 * @param type type of the parameter (string, number, boolean, object, array)
 * @param description optional description of the parameter
 * @param required whether the parameter is required or not
 */
export function toolparam(args: MagmaToolParam & { key: string; required?: boolean }) {
    return function <R extends MagmaToolReturnType | Promise<MagmaToolReturnType>>(
        target: object,
        propertyKey: string,
        descriptor: TypedPropertyDescriptor<
            ((call: MagmaToolCall, agent: MagmaAgent) => R) & {
                _methodName?: string;
                _parameterInfo?: (MagmaToolParam & { key: string; required?: boolean })[];
            }
        >
    ) {
        // Ensure metadata exists on this method's prototype
        if (!descriptor.value._methodName) {
            descriptor.value._methodName = propertyKey;
        }

        descriptor.value._parameterInfo ??= [];
        descriptor.value._parameterInfo.push(args);
    };
}

/**
 * Decorator for middleware functions to run during completion chains
 * @param trigger which middleware event should trigger the decorated function
 */
export function middleware<T extends MagmaMiddlewareTriggerType>(
    trigger: T,
    options: { critical?: boolean; order?: number } = { critical: false }
) {
    return function <
        R extends MagmaMiddlewareReturnType<T> | Promise<MagmaMiddlewareReturnType<T>>,
    >(
        target: object,
        propertyKey: string,
        descriptor: TypedPropertyDescriptor<
            ((content?: MagmaMiddlewareParamType<T>, agent?: MagmaAgent) => R) & {
                _middlewareTrigger?: T;
                _critical?: boolean;
                _order?: number;
                _name?: string;
                _id?: string;
            }
        >
    ) {
        if (!trigger) {
            throw new Error('Middleware trigger is required');
        }

        if (!MagmaMiddlewareTriggers.includes(trigger)) {
            throw new Error(`Invalid middleware trigger - ${trigger}`);
        }

        descriptor.value._middlewareTrigger = trigger;
        descriptor.value._critical = options.critical;
        descriptor.value._order = options.order;
        descriptor.value._name = propertyKey;
        descriptor.value._id = Math.random().toString(36).substring(2, 15);
        return descriptor;
    };
}

/**
 * Decorator for webhook functions
 * @param hookName name of the hook
 * @param options configuration options for the hook
 * @param options.session session configuration for the hook
 * Examples:
 * @hook('notification') -> POST /hooks/notification
 * @hook('notification', { session: 'default' })
 * @hook('notification', { session: (req) => req.body.userId })
 * @hook('notification', { session: fetchFromExternal(req) })
 */
export function hook(
    hookName: string,
    options: { session?: MagmaHook['session']; description?: string } = {}
) {
    return function <R extends void>(
        target: object,
        propertyKey: string,
        descriptor: TypedPropertyDescriptor<
            ((req: Request, res: Response, agent?: MagmaAgent) => R) & {
                _hookName?: string;
                _session?: MagmaHook['session'];
                _description?: string;
            }
        >
    ) {
        descriptor.value._hookName = hookName;
        descriptor.value._session = options.session;
        descriptor.value._description = options.description;
    };
}

/**
 * Decorator for scheduled jobs
 * @param cron cron expression (https://www.npmjs.com/package/node-cron#cron-syntax)
 * @param options configuration options for the job
 * @param options.timezone set the timezone for the job schedule
 */
export function job(cron: string, options: { timezone?: string } = {}) {
    // Validate cron expression
    if (!validate(cron)) {
        throw new Error(`Invalid cron expression - ${cron}`);
    }

    return function <R extends void>(
        target: object,
        propertyKey: string,
        descriptor: TypedPropertyDescriptor<
            ((agent?: MagmaAgent) => R) & { _schedule?: string; _options?: { timezone?: string } }
        >
    ) {
        descriptor.value._schedule = cron;
        descriptor.value._options = options;
    };
}
