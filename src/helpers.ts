import { MagmaAgent } from './agent';
import {
    MagmaHook,
    MagmaTool,
    MagmaToolParam,
    MagmaJob,
    MagmaMiddleware,
    MagmaUtilities,
} from './types';

/**
 * Helper function to recursively convert a MagmaToolParam to JSON object schema
 * @param param MagmaToolParam to convert to JSON object schema. Nested objects will be converted first
 * @param requiredList keys of required parameters
 * @returns { Record<string, any> } JSON object schema
 */
export const cleanParam = (
    param: MagmaToolParam & { key?: string; required?: boolean },
    requiredList?: string[]
): Record<string, any> => {
    param.required && param.key && requiredList?.push(param.key);

    const objectRequiredParams = [];

    switch (param.type) {
        case 'array':
            if (!param.items)
                throw new Error(
                    `Array parameters must have items defined - ${JSON.stringify(param)}`
                );
            return {
                type: 'array',
                description: param.description,
                items: cleanParam(param.items),
            };
        case 'object':
            if (!param.properties)
                throw new Error(
                    `Object parameters must have properties defined - ${JSON.stringify(param)}`
                );

            return {
                type: 'object',
                description: param.description,
                properties: Object.fromEntries(
                    param.properties.map((property) => {
                        if (!property.key)
                            throw new Error(
                                `Object properties must have keys defined - ${JSON.stringify(property)}`
                            );

                        return [property.key, cleanParam(property, objectRequiredParams)];
                    })
                ),
                required: objectRequiredParams,
            };
        case 'string':
            return {
                type: 'string',
                description: param.description,
                enum: param.enum,
            };

        case 'number':
            return {
                type: 'number',
                description: param.description,
                enum: param.enum,
            };
        case 'boolean':
            return {
                type: 'boolean',
                description: param.description,
            };
    }
};

export function loadUtilities(target: any): MagmaUtilities {
    const tools = loadTools(target);
    const hooks = loadHooks(target);
    const jobs = loadJobs(target);
    const middleware = loadMiddleware(target);

    return { tools, hooks, jobs, middleware };
}

export function getUtilitiesFromAgent(input: typeof MagmaAgent | MagmaAgent): MagmaUtilities[] {
    if (input instanceof MagmaAgent) {
        console.log('instance');
        return input.utilities;
    } else {
        console.log('class');
        const baseUtilities = [loadUtilities(input)];
        const childUtilities = input.getUtilities();

        return [...baseUtilities, ...childUtilities];
    }
}

/**
 * Helper function to load tools from a class or instance of a class
 * @param target class or instance of a class to load tools from
 * @returns array of MagmaTool objects
 */
export function loadTools(target: any): MagmaTool[] {
    const tools: MagmaTool[] = [];
    const { staticMethods, instanceMethods } = getMethodsFromClassOrInstance(target);
    const methods = [...staticMethods, ...instanceMethods];

    for (const method of methods) {
        if (typeof method === 'function' && '_toolInfo' in method) {
            const params: MagmaToolParam[] = method['_parameterInfo'] ?? [];
            tools.push({
                target: method.bind(target),
                name: (method['_toolInfo'] as any).name ?? method['_methodName'],
                description: (method['_toolInfo'] as any).description ?? undefined,
                params,
            } as MagmaTool);
        }
    }

    return tools;
}

export function loadHooks(target: any): MagmaHook[] {
    const hooks: MagmaHook[] = [];
    const { staticMethods, instanceMethods } = getMethodsFromClassOrInstance(target);
    const methods = [...staticMethods, ...instanceMethods];

    for (const method of methods) {
        if (typeof method === 'function' && '_hookName' in method) {
            hooks.push({
                name: method['_hookName'],
                handler: method.bind(target),
            } as MagmaHook);
        }
    }

    return hooks;
}

export function loadJobs(target: any): MagmaJob[] {
    const jobs: MagmaJob[] = [];
    const { staticMethods, instanceMethods } = getMethodsFromClassOrInstance(target);
    const methods = [...staticMethods, ...instanceMethods];

    for (const method of methods) {
        if (typeof method === 'function' && '_schedule' in method) {
            jobs.push({
                handler: method.bind(target),
                schedule: method['_schedule'],
                options: method['_options'],
            } as MagmaJob);
        }
    }

    return jobs;
}

export function loadMiddleware(target: any): MagmaMiddleware[] {
    const middleware: MagmaMiddleware[] = [];

    const { staticMethods, instanceMethods } = getMethodsFromClassOrInstance(target);
    const methods = [...staticMethods, ...instanceMethods];

    for (const method of methods) {
        if (typeof method === 'function' && '_middlewareTrigger' in method) {
            middleware.push({
                trigger: method['_middlewareTrigger'],
                action: method.bind(target),
            } as MagmaMiddleware);
        }
    }

    return middleware;
}

export function mapNumberInRange(
    n: number,
    min: number,
    max: number,
    newMin: number,
    newMax: number
): number {
    return ((n - min) * (newMax - newMin)) / (max - min) + newMin;
}

function getMethodsFromClassOrInstance(target: any): {
    staticMethods: Function[];
    instanceMethods: Function[];
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

    return { staticMethods, instanceMethods };
}

export async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export const hash = (str: string) => {
    let hash = 0;
    if (str.length === 0) return hash;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0;
    }
    return hash;
};
