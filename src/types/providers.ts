import Anthropic from '@anthropic-ai/sdk';
import { ChatCompletionCreateParamsBase as OpenAISettings } from 'openai/resources/chat/completions/completions';
import {
    GoogleGenerativeAI,
    ModelParams as GoogleModelParams,
    GenerationConfig as GoogleSettings,
    ToolConfig,
} from '@google/generative-ai';
import Groq from 'groq-sdk';
import { ChatCompletionCreateParams as GroqSettings } from 'groq-sdk/resources/chat/completions';
import OpenAI from 'openai';

export const MagmaProviders = ['openai', 'anthropic', 'groq', 'google'] as const;
export type MagmaProvider = (typeof MagmaProviders)[number];

export type MagmaClient = OpenAI | Anthropic | Groq | GoogleGenerativeAI;

export type AnthropicModel = Anthropic.Messages.Model;

export type OpenAIModel = OpenAISettings['model'];

export type GroqModel = GroqSettings['model'];

export type GoogleModel = GoogleModelParams['model'];

export type MagmaModel = AnthropicModel | OpenAIModel | GroqModel | GoogleModel;

type MagmaOpenAISettings = Omit<
    OpenAISettings,
    'messages' | 'model' | 'function_call' | 'functions' | 'stream' | 'stream_options' | 'tools'
>;
type MagmaAnthropicSettings = Omit<
    Anthropic.Messages.MessageCreateParams,
    'max_tokens' | 'messages' | 'model' | 'stream' | 'tools' | 'system'
> & { max_tokens?: number };
type MagmaGroqSettings = Omit<
    GroqSettings,
    'messages' | 'model' | 'function_call' | 'functions' | 'stream' | 'tools'
>;
type MagmaGoogleSettings = Omit<GoogleSettings, 'model'> & {
    toolConfig?: ToolConfig;
};

export type OpenAIProviderConfig = {
    client?: object;
    provider: 'openai';
    model: OpenAIModel;
    settings?: MagmaOpenAISettings;
};

export type AnthropicProviderConfig = {
    client?: object;
    provider: 'anthropic';
    model: AnthropicModel;
    settings?: MagmaAnthropicSettings;
};

export type GroqProviderConfig = {
    client?: object;
    provider: 'groq';
    model: GroqModel;
    settings?: MagmaGroqSettings;
};

export type GoogleProviderConfig = {
    client?: object;
    provider: 'google';
    model: GoogleModel;
    settings?: MagmaGoogleSettings;
};

export type MagmaProviderConfig =
    | OpenAIProviderConfig
    | AnthropicProviderConfig
    | GroqProviderConfig
    | GoogleProviderConfig;
