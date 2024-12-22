import { describe, it, expect } from 'vitest';
import { cleanParam, mapNumberInRange, sleep, hash, isInstanceOf } from '../src/helpers';
import { MagmaToolParam } from '../src/types';
import { loadTools, loadHooks } from '../src/helpers';
import { hook } from '../src/decorators';

describe('cleanParam', () => {
    it('should convert a simple string parameter', () => {
        const param: MagmaToolParam = {
            key: 'name',
            type: 'string',
            description: 'The name of the user',
            required: true,
        };

        const requiredList: string[] = [];
        const result = cleanParam(param, requiredList);

        expect(result).toEqual({
            type: 'string',
            description: 'The name of the user',
            enum: undefined,
        });
        expect(requiredList).toContain('name');
    });

    it('should convert an array parameter with items', () => {
        const param: MagmaToolParam = {
            key: 'numbers',
            type: 'array',
            description: 'A list of numbers',
            required: false,
            items: {
                key: 'number', // Add a key for consistency
                type: 'number',
                description: 'A single number',
                required: false,
            },
        };

        const requiredList: string[] = [];
        const result = cleanParam(param, requiredList);

        expect(result).toEqual({
            type: 'array',
            description: 'A list of numbers',
            items: {
                type: 'number',
                description: 'A single number',
                enum: undefined,
            },
        });
        expect(requiredList).not.toContain('numbers');
    });

    it('should throw an error if array items are not defined', () => {
        const param: MagmaToolParam = {
            key: 'numbers',
            type: 'array',
            description: 'A list of numbers',
            required: false,
            // Missing 'items' property
        };

        expect(() => cleanParam(param)).toThrowError(
            'Array parameters must have items defined - {"key":"numbers","type":"array","description":"A list of numbers","required":false}'
        );
    });

    it('should convert a nested object parameter', () => {
        const param: MagmaToolParam = {
            key: 'address',
            type: 'object',
            description: 'User address',
            required: true,
            properties: [
                {
                    key: 'street',
                    type: 'string',
                    description: 'Street name',
                    required: true,
                },
                {
                    key: 'city',
                    type: 'string',
                    description: 'City name',
                    required: true,
                },
                {
                    key: 'zip',
                    type: 'string',
                    description: 'ZIP code',
                    required: false,
                },
            ],
        };

        const requiredList: string[] = [];
        const result = cleanParam(param, requiredList);

        expect(result).toEqual({
            type: 'object',
            description: 'User address',
            properties: {
                street: {
                    type: 'string',
                    description: 'Street name',
                    enum: undefined,
                },
                city: {
                    type: 'string',
                    description: 'City name',
                    enum: undefined,
                },
                zip: {
                    type: 'string',
                    description: 'ZIP code',
                    enum: undefined,
                },
            },
            required: ['street', 'city'],
        });
        expect(requiredList).toContain('address');
    });

    it('should throw an error if object properties are not defined', () => {
        const param: MagmaToolParam = {
            key: 'address',
            type: 'object',
            description: 'User address',
            required: true,
            // Missing 'properties' array
        };

        expect(() => cleanParam(param)).toThrowError(
            'Object parameters must have properties defined - {"key":"address","type":"object","description":"User address","required":true}'
        );
    });

    it('should handle enum parameters', () => {
        const param: MagmaToolParam = {
            key: 'status',
            type: 'string',
            description: 'The status of the user',
            enum: ['active', 'inactive', 'pending'],
            required: true,
        };

        const requiredList: string[] = [];
        const result = cleanParam(param, requiredList);

        expect(result).toEqual({
            type: 'string',
            description: 'The status of the user',
            enum: ['active', 'inactive', 'pending'],
        });
        expect(requiredList).toContain('status');
    });
});

describe('cleanParam edge cases', () => {
    it('should throw error for object property without key', () => {
        const param: MagmaToolParam = {
            key: 'user',
            type: 'object',
            description: 'User info',
            required: true,
            properties: [
                {
                    // Missing 'key' here
                    type: 'string',
                    description: 'Name',
                    required: true,
                },
            ],
        };

        expect(() => cleanParam(param)).toThrowError(
            'Object properties must have keys defined - {"type":"string","description":"Name","required":true}'
        );
    });
});

describe('loadTools', () => {
    it('should load tools from a class instance', () => {
        class MyAgent {
            myMethod() { }

            anotherMethod() { }

            toolMethod() { }
        }

        // Mock method metadata
        (MyAgent.prototype.toolMethod as any)._toolInfo = {
            name: 'toolMethod',
            description: 'This is a tool method',
        };
        (MyAgent.prototype.toolMethod as any)._parameterInfo = [
            {
                key: 'param1',
                type: 'string',
                description: 'Parameter 1',
                required: true,
            },
        ];

        const agent = new MyAgent();
        const tools = loadTools(agent);

        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('toolMethod');
        expect(tools[0].description).toBe('This is a tool method');
        expect(tools[0].params).toEqual([
            {
                key: 'param1',
                type: 'string',
                description: 'Parameter 1',
                required: true,
            },
        ]);
        expect(typeof tools[0].target).toBe('function');
    });

    it('should return an empty array if no tools are found', () => {
        class EmptyAgent {
            myMethod() { }
        }

        const agent = new EmptyAgent();
        const tools = loadTools(agent);

        expect(tools).toEqual([]);
    });

    it('should load tools from a class (static methods)', () => {
        class StaticAgent {
            static toolMethod() { }
        }

        // Mock method metadata
        (StaticAgent.toolMethod as any)._toolInfo = {
            name: 'staticToolMethod',
            description: 'This is a static tool method',
        };
        (StaticAgent.toolMethod as any)._parameterInfo = [];

        const tools = loadTools(StaticAgent);

        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('staticToolMethod');
        expect(tools[0].description).toBe('This is a static tool method');
        expect(tools[0].params).toEqual([]);
        expect(typeof tools[0].target).toBe('function');
    });
});

describe('loadHooks', () => {
    it('should load hooks from instance methods', () => {
        class MyAgent {
            @hook('beforeProcess')
            beforeProcess() { }
        }

        const agent = new MyAgent();
        const hooks = loadHooks(agent);

        expect(hooks).toHaveLength(1);
        expect(hooks[0].name).toBe('beforeProcess');
        expect(typeof hooks[0].handler).toBe('function');
    });
});

describe('Utility Functions', () => {
    it('should correctly map number in range', () => {
        expect(mapNumberInRange(5, 0, 10, 0, 100)).toBe(50);
        expect(mapNumberInRange(0, 0, 10, 0, 100)).toBe(0);
        expect(mapNumberInRange(10, 0, 10, 0, 100)).toBe(100);
    });

    it('should sleep for specified duration', async () => {
        const start = Date.now();
        await sleep(100);
        const duration = Date.now() - start;
        expect(duration).toBeGreaterThanOrEqual(100);
    });

    it('should generate consistent hash for string', () => {
        const str = 'test string';
        const hash1 = hash(str);
        const hash2 = hash(str);
        expect(hash1).toBe(hash2);
        expect(hash('')).toBe(0);
    });

    it('should correctly check instance type', () => {
        class Parent { }
        class Child extends Parent { }

        const child = new Child();
        expect(isInstanceOf(child, Parent)).toBe(true);
        expect(isInstanceOf(null, Parent)).toBe(false);
        expect(isInstanceOf({}, Parent)).toBe(false);
    });
});