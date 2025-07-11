import type { MagmaAgent } from '../agent';
import {
    MagmaCompletion,
    MagmaCompletionConfig,
    MagmaCompletionStopReason,
    MagmaMessage,
    MagmaProvider,
    MagmaStreamChunk,
    MagmaTool,
    TraceEvent,
} from '../types';
import dotenv from 'dotenv';

dotenv.config();

interface ProviderProps {
    name: MagmaProvider;
}

export const MAX_RETRIES = 5;

export abstract class Provider implements ProviderProps {
    name: MagmaProvider;

    constructor(props: ProviderProps) {
        this.name = props.name;
    }

    public static factory(name: MagmaProvider): typeof Provider {
        const { AnthropicProvider } = require('./anthropic');
        const { GroqProvider } = require('./groq');
        const { OpenAIProvider } = require('./openai');
        const { GoogleProvider } = require('./google');
        switch (name) {
            case 'anthropic':
                return AnthropicProvider;
            case 'openai':
                return OpenAIProvider;
            case 'groq':
                return GroqProvider;
            case 'google':
                return GoogleProvider;
            default:
                throw new Error(`Can not create factory class Provider with type ${name}`);
        }
    }

    static convertMessages(messages: MagmaMessage[]): object[] {
        messages;
        throw new Error('Provider.convertMessages not implemented');
    }

    static async makeCompletionRequest({
        config,
        onStreamChunk,
        attempt = 0,
        signal,
        agent,
        trace,
        requestId,
    }: {
        config: MagmaCompletionConfig;
        onStreamChunk?: (chunk: MagmaStreamChunk | null) => Promise<void> | void;
        attempt: number;
        signal?: AbortSignal;
        agent: MagmaAgent;
        trace: TraceEvent[];
        requestId: string;
    }): Promise<MagmaCompletion | null> {
        config;
        onStreamChunk;
        attempt;
        signal;
        throw new Error('Provider.makeCompletionRequest not implemented');
    }

    static convertTools(tools: MagmaTool[]): object[] {
        tools;
        throw new Error('Provider.convertTools not implemented');
    }

    static convertConfig(config: MagmaCompletionConfig): object {
        config;
        throw new Error('Provider.convertConfig not implemented');
    }

    static convertStopReason(stop_reason: string): MagmaCompletionStopReason {
        stop_reason;
        throw new Error('Provider.convertStopReason not implemented');
    }
}
