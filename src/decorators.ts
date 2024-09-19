import { MagmaToolParam, MiddlewareTriggerType } from './types';

/**
 * Decorator to define a tool (optional)
 * @param args name and description for tool
 */
export function tool(args: { name?: string; description?: string }) {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
        descriptor.value._toolInfo = {
            name: args.name ?? propertyKey,
            description: args.description,
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
export function toolparam(args: MagmaToolParam) {
    return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
        // Ensure metadata exists on this method's prototype
        if (!descriptor.value._methodName) {
            descriptor.value._methodName = propertyKey;
        }

        descriptor.value._parameterInfo ??= [];
        descriptor.value._parameterInfo.push(args);
    };
}

export function middleware(trigger: MiddlewareTriggerType) {}
