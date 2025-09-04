import { z, ZodType } from 'zod';
import { MagmaTool, MagmaToolParam } from '../types';
import { tool } from 'ai';

const numberEnum = <Num extends number, T extends Readonly<Num[]>>(
    args: T
): z.ZodSchema<T[number]> => {
    return z.custom<T[number]>((val: any) => args.includes(val));
};

export function convertMagmaToolParamToZodType(
    magmaToolParam: MagmaToolParam & { required?: boolean }
): ZodType {
    let result;
    switch (magmaToolParam.type) {
        case 'boolean':
            result = z.boolean();
            break;
        case 'number':
            if (magmaToolParam.enum) {
                result = numberEnum(magmaToolParam.enum);
            } else {
                result = z.number();
            }
            break;
        case 'string':
            if (magmaToolParam.enum) {
                result = z.enum(magmaToolParam.enum);
            } else {
                result = z.string();
            }
            break;
        case 'array':
            result = z.array(convertMagmaToolParamToZodType(magmaToolParam.items));
            if (magmaToolParam.limit) {
                result = result.max(magmaToolParam.limit);
            }
            break;
        case 'object':
            result = z.object(
                Object.fromEntries(
                    magmaToolParam.properties.map((p) => [p.key, convertMagmaToolParamToZodType(p)])
                )
            );
            break;
        default:
            const error = 'Invalid tool param: ' + JSON.stringify(magmaToolParam, null, 2);
            throw new Error(error);
    }

    if (!magmaToolParam.required) {
        result = result.optional();
    }

    if (magmaToolParam.description) {
        result = result.describe(magmaToolParam.description);
    }

    return result;
}

export function convertMagmaToolToAISDKTool(magmaTool: MagmaTool) {
    return tool({
        description: magmaTool.description,
        inputSchema: convertMagmaToolParamToZodType({
            type: 'object',
            properties: magmaTool.params,
            required: true,
        }),
    });
}
