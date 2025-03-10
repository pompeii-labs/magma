import {
    MagmaToolParam,
    MagmaMiddlewareTriggerType,
    MagmaMiddlewareTriggers,
    HookRequestPath,
    HookRequestLocation,
    MagmaMiddlewareParamType,
    MagmaMiddlewareReturnType,
    MagmaState,
} from './types';
import { validate } from 'node-cron';

/**
 * Decorator to define a tool (optional)
 * @param args name and description for tool
 */
export function tool(args: { name?: string; description?: string; cache?: boolean }) {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
        descriptor.value._toolInfo = {
            name: args.name ?? propertyKey,
            description: args.description,
            cache: args.cache,
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
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
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
    options: { critical?: boolean } = { critical: false }
) {
    return function <
        R extends MagmaMiddlewareReturnType<T> | Promise<MagmaMiddlewareReturnType<T>>,
    >(
        target: object,
        propertyKey: string,
        descriptor: TypedPropertyDescriptor<
            ((content?: MagmaMiddlewareParamType<T>, state?: MagmaState) => R) & {
                _middlewareTrigger?: T;
                _critical?: boolean;
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
        return descriptor;
    };
}

/**
 * Decorator for webhook functions
 * @param hookName name of the hook
 * ex: @hook('notification') -> POST /hooks/notification
 */
export function hook(
    hookName: string,
    options: { agentIdPath?: HookRequestPath<HookRequestLocation> } = {}
) {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
        descriptor.value._hookName = hookName;
        descriptor.value._agentIdPath = options.agentIdPath;
    };
}

/**
 * Decorator for scheduled jobs
 * @param cron cron expression
 */
export function job(cron: string, options: { timezone?: string } = {}) {
    // Validate cron expression
    if (!validate(cron)) {
        throw new Error(`Invalid cron expression - ${cron}`);
    }

    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
        descriptor.value._schedule = cron;
        descriptor.value._options = options;
    };
}
