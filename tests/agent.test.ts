import { describe, it, expect, afterEach } from 'vitest';
import { MagmaAgent } from '../src/agent';

describe('MagmaAgent Constructor', () => {
    it('should initialize with default values when no arguments are provided', () => {
        const agent = new MagmaAgent();

        expect(agent.agentId).toBeUndefined();
        expect(agent.logger).toBeUndefined();
        expect(agent.state).toBeInstanceOf(Map);
        expect(agent.providerName).toBe('openai');
    });
});

import { MagmaMiddlewareTriggerType, MagmaProviderConfig, MagmaUserMessage } from '../src/types';

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
        expect((messages.at(-1) as MagmaUserMessage).content).toBe('Message 30');
    });

    it('should return all messages when slice is -1', () => {
        const agent = new MagmaAgent();
        for (let i = 0; i < 30; i++) {
            agent.addMessage({ role: 'user', content: `Message ${i + 1}` });
        }

        const messages = agent.getMessages(-1);
        expect(messages).toHaveLength(30);
        expect((messages[0] as MagmaUserMessage).content).toBe('Message 1');
        expect((messages[0] as MagmaUserMessage).content).toBe('Message 30');
    });
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

describe('receive Method', () => {
    it('should throw an error when not implemented', async () => {
        const agent = new MagmaAgent();

        await expect(agent.receive({})).rejects.toThrowError('Agent.receive function not implemented');
    });
});

import { Provider } from '../src/providers';
import { MagmaConfig } from '../src/types';
import { vi } from 'vitest';

describe('main Method', () => {
    it('should handle main flow without tools and middleware', async () => {
        const agent = new MagmaAgent();
        agent.addMessage({ role: 'user', content: 'Hello assistant!' });

        const mockProvider = {
            makeCompletionRequest: vi.fn(async (config: MagmaConfig) => ({
                message: { role: 'assistant', content: 'Hello user!' },
                usage: {},
            })),
        };

        // Mock the static factory method instead of the entire Provider
        vi.spyOn(Provider, 'factory').mockImplementation(() => mockProvider as any);

        const response = await agent.main();

        expect(response).toEqual({ role: 'assistant', content: 'Hello user!' });
        expect(mockProvider.makeCompletionRequest).toHaveBeenCalled();

        vi.restoreAllMocks();
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

        const mockProvider = { makeCompletionRequest };
        const providerFactorySpy = vi.spyOn(Provider, 'factory').mockReturnValue(mockProvider);

        const response = await agent.main();

        expect(testTool.target).toHaveBeenCalled();
        expect(makeCompletionRequest).toHaveBeenCalledTimes(2);
        expect(response).toEqual({ role: 'assistant', content: 'Tool has been executed' });

        providerFactorySpy.mockRestore();
    });
});

import { middleware } from '../src/decorators';
import { MagmaMiddleware } from '../src/types';

describe('Middleware Loading', () => {
    it('should load middleware methods', () => {
        class AgentWithMiddleware extends MagmaAgent {
            @middleware('preCompletion')
            async modifyMessage() {
                // Middleware logic
            }
        }

        const agent = new AgentWithMiddleware();
        const middleware = (agent as any).middleware as MagmaMiddleware[];

        expect(middleware).toHaveLength(1);
        expect(middleware[0].trigger).toBe('preCompletion');
    });
});

import { tool } from '../src/decorators';
import { MagmaTool } from '../src/types';

describe('Tool Loading', () => {
    it('should load tool methods', () => {
        class AgentWithTool extends MagmaAgent {
            testTool() {
                return 'Tool executed';
            }
        }

        const agent = new AgentWithTool();
        const tools = (agent as any).tools as MagmaTool[];

        // Add tool info to the prototype method
        Object.getPrototypeOf(agent).testTool._toolInfo = {
            name: 'test_tool',
            description: 'A test tool'
        };

        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('test_tool');
        expect(tools[0].description).toBe('A test tool');
    });
});