import {
    MagmaHook,
    MagmaJob,
    MagmaMiddleware,
    MagmaTool,
    MagmaToolParam,
    MagmaUtilities,
} from '../types';

function getMethodsFromClassOrInstance(target: any): {
    staticMethods: Function[];
    instanceMethods: Function[];
    isInstance: boolean;
} {
    const isClass = /^\s*class\s+/.test(target.toString());
    const isInstance = typeof target === 'object' && !isClass ? true : false;
    const staticMethods: Function[] = [];
    const instanceMethods: Function[] = [];

    if (isInstance) {
        const prototype = Object.getPrototypeOf(target);
        const instancePropertyNames = Object.getOwnPropertyNames(prototype);
        const constructor = prototype.constructor;
        const staticPropertyNames = Object.getOwnPropertyNames(constructor);
        staticMethods.push(...staticPropertyNames.map((name) => constructor[name]));
        instanceMethods.push(...instancePropertyNames.map((name) => prototype[name]));
    } else {
        const staticPropertyNames = Object.getOwnPropertyNames(target);
        staticMethods.push(...staticPropertyNames.map((name) => target[name]));
    }

    return { staticMethods, instanceMethods, isInstance: !isClass };
}

/**
 * Helper function to load utilities from a class or instance of a class
 * If the target is a class, it will load the static utilities
 * If the target is an instance of a class, it will load the instance utilities (static Tools and Middleware are also loaded)
 * @param target class or instance of a class to load utilities from
 * @returns MagmaUtilities object
 */
export function loadUtilities(target: any): MagmaUtilities {
    const tools = loadTools(target);
    const hooks = loadHooks(target);
    const jobs = loadJobs(target);
    const middleware = loadMiddleware(target);

    return { tools, hooks, jobs, middleware };
}

/**
 * Helper function to load tools from a class or instance of a class
 * If the target is an instance, it will load both the static and instance tools
 * @param target class or instance of a class to load tools from
 * @returns array of MagmaTool objects
 */
export function loadTools(target: any): MagmaTool[] {
    const tools: MagmaTool[] = [];
    const { staticMethods, instanceMethods } = getMethodsFromClassOrInstance(target);
    const methods = [...staticMethods, ...instanceMethods];

    for (const method of methods) {
        if (typeof method === 'function' && ('_toolInfo' in method || '_parameterInfo' in method)) {
            const params: MagmaToolParam[] = method['_parameterInfo'] ?? [];
            tools.push({
                target: method.bind(target),
                name: (method['_toolInfo'] as any)?.name ?? method['_methodName'],
                description: (method['_toolInfo'] as any)?.description ?? undefined,
                params,
                enabled: (method['_toolInfo'] as any)?.enabled ?? (() => true),
                cache: (method['_toolInfo'] as any)?.cache ?? false,
            } as MagmaTool);
        }
    }

    return tools;
}

/**
 * Helper function to load hooks from a class or instance of a class
 * If the target is a class, it will load the static hooks
 * If the target is an instance of a class, it will load the instance hooks
 * @param target class or instance of a class to load hooks from
 * @returns array of MagmaHook objects
 */
export function loadHooks(target: any): MagmaHook[] {
    const hooks: MagmaHook[] = [];
    const { staticMethods, instanceMethods, isInstance } = getMethodsFromClassOrInstance(target);
    const methods = isInstance ? instanceMethods : staticMethods;

    for (const method of methods) {
        if (typeof method === 'function' && '_hookName' in method) {
            hooks.push({
                name: method['_hookName'],
                handler: method.bind(target),
                session: method['_session'],
            } as MagmaHook);
        }
    }

    return hooks;
}

/**
 * Helper function to load jobs from a class or instance of a class
 * If the target is a class, it will load the static jobs
 * If the target is an instance of a class, it will load the instance jobs
 * @param target class or instance of a class to load jobs from
 * @returns array of MagmaJob objects
 */
export function loadJobs(target: any): MagmaJob[] {
    const jobs: MagmaJob[] = [];
    const { staticMethods, instanceMethods, isInstance } = getMethodsFromClassOrInstance(target);
    const methods = isInstance ? instanceMethods : staticMethods;

    for (const method of methods) {
        if (typeof method === 'function' && '_schedule' in method) {
            jobs.push({
                handler: method.bind(target),
                schedule: method['_schedule'],
                options: method['_options'],
                name: method['_methodName'] || method['name'],
            } as MagmaJob);
        }
    }

    return jobs;
}

/**
 * Helper function to load middleware from a class or instance of a class
 * If the target is an instance, it will load both the static and instance middleware
 * @param target class or instance of a class to load middleware from
 * @returns array of MagmaMiddleware objects
 */
export function loadMiddleware(target: any): MagmaMiddleware[] {
    const middleware: MagmaMiddleware[] = [];

    const { staticMethods, instanceMethods } = getMethodsFromClassOrInstance(target);
    const methods = [...staticMethods, ...instanceMethods];

    for (const method of methods) {
        if (typeof method === 'function' && '_middlewareTrigger' in method) {
            middleware.push({
                trigger: method['_middlewareTrigger'],
                action: method.bind(target),
                name: method['_methodName'] || method['name'],
                critical: method['_critical'] ?? false,
                order: method['_order'],
            } as MagmaMiddleware);
        }
    }

    return middleware;
}
