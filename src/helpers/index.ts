import { MagmaMessage, MagmaToolParam } from '../types';

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

/**
 * Helper function to sanitize messages by removing tool calls and tool results that are not preceded by a tool call or tool result. This function operates on the messages array in place.
 * @param messages MagmaMessage[] to sanitize
 */
export function sanitizeMessages(messages: MagmaMessage[]): void {
    for (let i = 0; i < messages.length; i++) {
        // if the message is a tool call
        if (messages[i].role === 'assistant' && messages[i].getToolCalls().length > 0) {
            // console.log('Tool call found', messages[i]);
            // if the message is at the end of the array, we need to remove it
            if (i === messages.length - 1) {
                // console.log(
                //     'Tool call found at the end of the array, removing',
                //     messages[i]
                // );
                messages.pop();
            } else {
                // if the message is not at the end of the array, make sure the next message is a tool result
                if (
                    messages[i + 1].role === 'user' &&
                    messages[i + 1].getToolResults().length > 0
                ) {
                    // console.log('Tool call found with tool result, continuing');
                    continue;
                } else {
                    // console.log(
                    //     'Tool call found with no tool result, removing',
                    //     messages[i]
                    // );
                    messages.splice(i, 1);
                    i--;
                }
            }
            // if the message is a tool result
        } else if (messages[i].role === 'user' && messages[i].getToolResults().length > 0) {
            // console.log('Tool result found', messages[i]);
            // if the message is at the beginning of the array, we need to remove it
            if (i === 0) {
                // console.log(
                //     'Tool result found at the beginning of the array, removing',
                //     messages[i]
                // );
                messages.shift();
                i--;
            } else {
                // if the message is not at the beginning of the array, make sure the previous message is a tool call
                if (
                    messages[i - 1].role === 'assistant' &&
                    messages[i - 1].getToolCalls().length > 0
                ) {
                    // console.log('Tool result found with tool call, continuing');
                    continue;
                } else {
                    // console.log(
                    //     'Tool result found with no tool call, removing',
                    //     messages[i]
                    // );
                    messages.splice(i, 1);
                    i--;
                }
            }
        }
    }
}

export * from './trace';
export * from './utilities';
