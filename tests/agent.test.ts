import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { MagmaAgent } from '../src/agent';
import { Provider } from '../src/providers';
import { middleware } from '../src/decorators';
import { MagmaMiddleware } from '../src/types';
import { tool } from '../src/decorators';
import { MagmaTool } from '../src/types';
import { MagmaConfig } from '../src/types';
import { vi } from 'vitest';
import { MagmaMiddlewareTriggerType, MagmaProviderConfig, MagmaUserMessage } from '../src/types';

describe('MagmaAgent Constructor', () => {
    it('should initialize with default values when no arguments are provided', () => {
        const agent = new MagmaAgent();

        expect(agent.agentId).toBeUndefined();
        expect(agent.logger).toBeUndefined();
        expect(agent.state).toBeInstanceOf(Map);
        expect(agent.providerName).toBe('openai');
    });
});

describe('MagmaAgent Constructor', () => {
    it('should initialize with provided provider config', () => {
        const providerConfig: MagmaProviderConfig = {
            provider: 'anthropic',
            model: 'claude-1',
        };
        const agent = new MagmaAgent({ providerConfig });

        expect(agent.providerName).toBe('anthropic');
    });
});

describe('setProviderConfig Method', () => {
    it('should set the provider config', () => {
        const agent = new MagmaAgent();
        const providerConfig: MagmaProviderConfig = {
            provider: 'anthropic',
            model: 'claude-sonnet-latest',
        };

        agent.setProviderConfig(providerConfig);

        expect(agent.providerName).toBe('anthropic');
    });
});

describe('setProviderConfig Method', () => {
    it('should throw an error if provider client and provider are not defined', () => {
        const agent = new MagmaAgent();

        expect(() => {
            agent.setProviderConfig({} as any);
        }).toThrowError('Provider client or provider must be defined');
    });

    it('should throw an error if invalid provider is provided', () => {
        const agent = new MagmaAgent();
        const providerConfig = {
            provider: 'invalidProvider',
            model: 'someModel',
        } as any;

        expect(() => {
            agent.setProviderConfig(providerConfig);
        }).toThrowError('Invalid provider');
    });
});

import { MagmaMessage } from '../src/types';

describe('addMessage Method', () => {
    it('should add a message to the messages list', () => {
        const agent = new MagmaAgent();
        const message: MagmaMessage = { role: 'user', content: 'Hello' };

        agent.addMessage(message);

        const messages = agent.getMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual(message);
    });
});

describe('removeMessage Method', () => {
    it('should remove the last message when no filter is provided', () => {
        const agent = new MagmaAgent();
        agent.addMessage({ role: 'user', content: 'Hello' });
        agent.addMessage({ role: 'assistant', content: 'Hi there!' });

        agent.removeMessage();

        const messages: MagmaMessage[] = agent.getMessages();
        expect(messages).toHaveLength(1);
        expect((messages[0] as MagmaUserMessage).content).toBe('Hello');
    });

    it('should remove messages that match the filter', () => {
        const agent = new MagmaAgent();
        agent.addMessage({ role: 'user', content: 'Hello' });
        agent.addMessage({ role: 'assistant', content: 'Hi there!' });

        agent.removeMessage((message) => message.role === 'user');

        const messages = agent.getMessages();
        console.log(messages[0], messages[0].role);
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('assistant');
    });
});

describe('getMessages Method', () => {
    it('should return the last N messages', () => {
        const agent = new MagmaAgent();
        for (let i = 0; i < 30; i++) {
            agent.addMessage({ role: 'user', content: `Message ${i + 1}` });
        }

        const messages = agent.getMessages(20);
        expect(messages).toHaveLength(20);
        expect((messages[0] as MagmaUserMessage).content).toBe('Message 11');
        expect((messages[19] as MagmaUserMessage).content).toBe('Message 30');
    });

    it('should return all messages when slice is -1', () => {
        const agent = new MagmaAgent();
        for (let i = 0; i < 30; i++) {
            agent.addMessage({ role: 'user', content: `Message ${i + 1}` });
        }

        const messages = agent.getMessages(-1);
        expect(messages).toHaveLength(30);
        expect((messages[29] as MagmaUserMessage).content).toBe('Message 30');
        expect((messages[0] as MagmaUserMessage).content).toBe('Message 1');
    });

    describe('setTTSConfig Method', () => {
        it('should correctly set TTS configuration', () => {
            class TestAgent extends MagmaAgent {
                get ttsConfigValue() {
                    return (this as any).ttsConfig;
                }
            }
            const agent = new TestAgent();
            agent.setTTSConfig({ voice: 'en-US-Wavenet-D' });

            expect(agent.ttsConfigValue).toEqual({ voice: 'en-US-Wavenet-D' });
        });
    });

    describe('setSTTConfig Method', () => {
        it('should correctly set STT configuration', () => {
            class TestAgent extends MagmaAgent {
                get sttConfigValue() {
                    return (this as any).sttConfig;
                }
            }
            const agent = new TestAgent();
            agent.setSTTConfig({ mode: 'vad' });

            expect(agent.sttConfigValue).toEqual({ mode: 'vad' });
        });
    });

    describe('setup Method', () => {
        it('should throw an error when not implemented', async () => {
            const agent = new MagmaAgent();

            await expect(agent.setup()).rejects.toThrowError('Agent.setup function not implemented');
        });
    });

    describe('MagmaAgent Constructor', () => {
        beforeEach(() => {
            vi.mock('openai', () => ({
                default: vi.fn().mockImplementation(() => ({

                }))
            }));
        });

        afterEach(() => {
            vi.clearAllMocks();
        });

        it('should initialize with default values when no arguments are provided', () => {
            const agent = new MagmaAgent();

            expect(agent.agentId).toBeUndefined();
            expect(agent.logger).toBeUndefined();
            expect(agent.state).toBeInstanceOf(Map);
            expect(agent.providerName).toBe('openai');
        });
    });

    describe('receive Method', () => {
        it('should throw an error when not implemented', async () => {
            const agent = new MagmaAgent();

            await expect(agent.receive({})).rejects.toThrowError('Agent.receive function not implemented');
        });
    });

    describe('main Method', () => {
        it('should handle main flow without tools and middleware', async () => {
            // Mock the entire Provider module
            vi.mock('../src/providers', () => ({
                Provider: {
                    factory: vi.fn().mockReturnValue({
                        makeCompletionRequest: vi.fn().mockResolvedValue({
                            message: { role: 'assistant', content: 'Hello user!' },
                            usage: {},
                        })
                    })
                }
            }));

            const agent = new MagmaAgent();
            agent.addMessage({ role: 'user', content: 'Hello assistant!' });

            const response = await agent.main();

            expect(response).toEqual({ role: 'assistant', content: 'Hello user!' });

            // Clean up
            vi.clearAllMocks();
            vi.resetModules();
        });
    });

    describe('main Method', () => {
        it('should handle tool execution when tool_call is returned', async () => {
            const testTool = {
                name: 'test_tool',
                description: 'A test tool',
                params: [],
                target: vi.fn(async () => 'Tool executed successfully'),
            };

            class TestAgent extends MagmaAgent {
                fetchTools() {
                    return [testTool];
                }
            }

            const agent = new TestAgent();
            agent.addMessage({ role: 'user', content: 'Please run test tool' });

            const makeCompletionRequest = vi
                .fn()
                .mockResolvedValueOnce({
                    message: {
                        role: 'tool_call',
                        fn_name: 'test_tool',
                        fn_args: {},
                        tool_call_id: '123',
                    },
                    usage: {},
                })
                .mockResolvedValueOnce({
                    message: { role: 'assistant', content: 'Tool has been executed' },
                    usage: {},
                });

            const MockProvider = vi.fn(() => { }) as unknown as typeof Provider;
            MockProvider.factory = vi.fn();
            MockProvider.makeCompletionRequest = makeCompletionRequest;
            MockProvider.convertMessages = vi.fn();
            MockProvider.convertTools = vi.fn();
            MockProvider.convertConfig = vi.fn();

            const providerFactorySpy = vi
                .spyOn(Provider, 'factory')
                .mockReturnValue(MockProvider);

            const response = await agent.main();

            expect(testTool.target).toHaveBeenCalled();
            expect(makeCompletionRequest).toHaveBeenCalledTimes(2);
            expect(response).toEqual({ role: 'assistant', content: 'Tool has been executed' });

            providerFactorySpy.mockRestore();
        });
    });



    describe('Middleware Loading', () => {
        it('should load middleware methods', () => {
            class AgentWithMiddleware extends MagmaAgent {
                @middleware('preCompletion')
                async modifyMessage(message: any): Promise<void> {
                    // Middleware logic
                    message; // prevent unused param warning
                }
            }

            const agent = new AgentWithMiddleware();
            const middlewares = (agent as any).middleware;

            expect(middlewares).toHaveLength(1);
            expect(middlewares[0].trigger).toBe('preCompletion');
            expect(typeof middlewares[0].action).toBe('function');
        });
    });

    describe('Tool Loading', () => {
        it('should load tool methods', () => {
            class AgentWithTool extends MagmaAgent {
                @tool({
                    name: 'test_tool',
                    description: 'A tool that tests tools'
                })
                testTool() {
                    return 'Tool executed';
                }
            }

            const agent = new AgentWithTool();
            const tools = (agent as any).tools as MagmaTool[];

            Object.getPrototypeOf(agent).testTool._toolInfo = {
                name: 'test_tool',
                description: 'A test tool'
            };

            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe('test_tool');
            expect(tools[0].description).toBe('A tool that tests tools');
        });
    });
});