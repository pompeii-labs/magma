import { MagmaAssistantMessage, MagmaMessage, MagmaToolParam } from '../types';

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

    const objectRequiredParams: string[] = [];

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

export function mapNumberInRange(
    n: number,
    min: number,
    max: number,
    newMin: number,
    newMax: number
): number {
    return ((n - min) * (newMax - newMin)) / (max - min) + newMin;
}

export async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseErrorToString(error: unknown): string {
    return parseErrorToError(error).message;
}

export function parseErrorToError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    } else if (typeof error === 'string') {
        return new Error(error);
    } else {
        return new Error(JSON.stringify(error));
    }
}

export function getMessageText(message: MagmaMessage): string {
    if (typeof message.content === 'string') {
        return message.content;
    } else {
        return message.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n');
    }
}

export function getMessageReasoning(message: MagmaAssistantMessage): string {
    if (typeof message.content === 'string') {
        return '';
    } else {
        return message.content
            .filter((p) => p.type === 'reasoning')
            .map((p) => p.text)
            .join('\n');
    }
}

export * from './trace';
export * from './utilities';
