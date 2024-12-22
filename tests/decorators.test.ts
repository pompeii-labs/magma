import { describe, it, expect } from 'vitest';
import { tool, toolparam, middleware, hook, job } from '../src/decorators';
import { MagmaAgent } from '../src/agent';
import { MagmaToolCall, MagmaMiddlewareTriggerType } from '../src/types';
import { loadTools, loadHooks, loadJobs } from '../src/helpers';

describe('@toolparam decorator', () => {
    it('should correctly set parameter metadata on method', () => {
        class Agent extends MagmaAgent {
            @tool({ description: 'Search the database' })
            @toolparam({
                key: 'query',
                type: 'string',
                description: 'Search query',
                required: true,
            })
            async searchDatabase(call: MagmaToolCall): Promise<string> {
                return `Searching for ${call.fn_args.query}`;
            }
        }

        const tools = loadTools(Agent);

        // Get the decorated method
        const instance = new Agent();
        const method = Object.getPrototypeOf(instance).searchDatabase;

        // Check if parameter metadata was set correctly
        expect(method._parameterInfo).toEqual([
            {
                key: 'query',
                type: 'string',
                description: 'Search query',
                required: true,
            },
        ]);
    });
});

describe('@middleware decorator', () => {
    it('should correctly set middleware trigger on method', () => {
        class Agent extends MagmaAgent {
            @middleware('preCompletion')
            async logBeforeCompletion(message: any): Promise<void> {
                // Middleware logic
            }
        }

        const instance = new Agent();
        const method = Object.getPrototypeOf(instance).logBeforeCompletion;

        // Check if middleware trigger was set correctly
        expect(method._middlewareTrigger).toEqual('preCompletion');
    });

    it('should throw an error for invalid middleware trigger', () => {
        expect(() => {
            class Agent extends MagmaAgent {
                @middleware('invalidTrigger' as MagmaMiddlewareTriggerType)
                async invalidMiddleware(): Promise<void> {
                    // Middleware logic
                }
            }
        }).toThrowError('Invalid middleware trigger - invalidTrigger');
    });
});

describe('@hook decorator', () => {
    it('should correctly set hook name on method', () => {
        class Agent extends MagmaAgent {
            @hook('user_registered')
            async handleUserRegistration(req: any): Promise<void> {
                // Handle user registration hook
            }
        }

        // Create an instance of Agent
        const instance = new Agent();

        // Pass the instance to loadHooks
        const hooks = loadHooks(instance);

        // Get the decorated method
        const method = Object.getPrototypeOf(instance).handleUserRegistration;

        // Check if hook name was set correctly
        expect(method._hookName).toEqual('user_registered');

        // Check if the hook was loaded correctly
        expect(hooks).toHaveLength(1);
        expect(hooks[0].name).toBe('user_registered');
        expect(typeof hooks[0].handler).toBe('function');
    });
});

describe('@job decorator', () => {
    it('should correctly set schedule on method', () => {
        class Agent extends MagmaAgent {
            @job('0 0 * * *')
            async dailyCleanup(): Promise<void> {
                // Job logic
            }
        }

        // Get the decorated method
        const instance = new Agent();
        const jobs = loadJobs(instance);
        const method = Object.getPrototypeOf(instance).dailyCleanup;

        // Check if schedule and options were set correctly
        expect(method._schedule).toEqual('0 0 * * *');
        expect(method._options).toBeUndefined();

        // Check if the job was loaded correctly
        expect(jobs).toHaveLength(1);
        expect(jobs[0].schedule).toBe('0 0 * * *');
        expect(typeof jobs[0].handler).toBe('function');
    });

    it('should correctly set schedule and options on method', () => {
        class Agent extends MagmaAgent {
            @job('0 * * * *', { timezone: 'America/New_York' })
            async hourlySync(): Promise<void> {
                // Job logic
            }
        }

        // Get the decorated method
        const instance = new Agent();
        const jobs = loadJobs(instance);
        const method = Object.getPrototypeOf(instance).hourlySync;

        // Check if schedule and options were set correctly
        expect(method._schedule).toEqual('0 * * * *');
        expect(method._options).toEqual({ timezone: 'America/New_York' });

        // Check if the job was loaded correctly
        expect(jobs).toHaveLength(1);
        expect(jobs[0].schedule).toBe('0 * * * *');
        expect(jobs[0].options).toEqual({ timezone: 'America/New_York' });
        expect(typeof jobs[0].handler).toBe('function');
    });

    it('should throw an error for invalid cron expression', () => {
        expect(() => {
            class Agent extends MagmaAgent {
                @job('invalid cron')
                async invalidJob(): Promise<void> {
                    // Job logic
                }
            }
            // Instantiate to trigger decorator
            new Agent();
        }).toThrowError('Invalid cron expression - invalid cron');
    });
});