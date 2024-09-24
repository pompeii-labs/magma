import { MagmaTool, MagmaToolParam } from './types';

/**
 * Helper function to recursively convert a MagmaToolParam to JSON object schema
 * @param param MagmaToolParam to convert to JSON object schema. Nested objects will be converted first
 * @param requiredList keys of required parameters
 * @returns { Record<string, any> } JSON object schema
 */
export const cleanParam = (param: MagmaToolParam, requiredList?: string[]): Record<string, any> => {
    param.required && requiredList?.push(param.key);

    const objectRequiredParams = [];

    switch (param.type) {
    case 'array':
        if (!param.items)
            throw new Error(
                `Array parameters must have items defined - ${JSON.stringify(param)}`,
            );
        return {
            type: 'array',
            description: param.description,
            items: cleanParam(param.items),
        };
    case 'object':
        if (!param.properties)
            throw new Error(
                `Object parameters must have properties defined - ${JSON.stringify(param)}`,
            );

        return {
            type: 'object',
            description: param.description,
            properties: Object.fromEntries(
                param.properties.map((property) => {
                    if (!property.key)
                        throw new Error(
                            `Object properties must have keys defined - ${JSON.stringify(property)}`,
                        );

                    return [property.key, cleanParam(property, objectRequiredParams)];
                }),
            ),
            required: objectRequiredParams,
        };
    default:
        return {
            type: param.type,
            description: param.description,
            enum: param.enum,
        };
    }
};

export function loadTools(target: any) {
    const isClass = /^\s*class\s+/.test(target.toString());
    const isInstance =
        typeof target === 'object' && !isClass ? true : false;
    let propertyNames = [];
    let prototype: object = undefined;

    if (isInstance) {
        prototype = Object.getPrototypeOf(target);
        propertyNames = Object.getOwnPropertyNames(prototype);
    } else {
        propertyNames = Object.getOwnPropertyNames(target);
    }

    const tools: MagmaTool[] = propertyNames
        .map((fxn) => {
            const method = isInstance ? prototype[fxn] : target[fxn];

            if (
                !(
                    typeof method === 'function' &&
                    ('_parameterInfo' in method || '_toolInfo' in method)
                )
            )
                return null;

            const params =
                method['_parameterInfo'] ?? ([] as MagmaToolParam[]);
            const toolInfo = method['_toolInfo'];
            const name = toolInfo?.name ?? method['_methodName'];
            const description = toolInfo?.description ?? undefined;

            return {
                target: method.bind(target),
                name,
                description,
                params,
            } as MagmaTool;
        })
        .filter((f) => f);

    return tools ?? [];
}

export function mapNumberInRange(
    n: number,
    min: number,
    max: number,
    newMin: number,
    newMax: number,
): number {
    return ((n - min) * (newMax - newMin)) / (max - min) + newMin;
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

export const isInstanceOf = (obj: any, type: any): boolean => {
    if (!obj || !obj.constructor || !type) return false;
  
    // Iterate through properties of obj's constructor and check if they exist in the type
    for (const property in obj.constructor) {
      if (!type[property]) return false;
    }
  
    return true;
  };
  