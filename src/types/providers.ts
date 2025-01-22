import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';
import { ChatModel } from 'openai/resources/index';

export const MagmaProviders = ['openai', 'anthropic', 'groq', 'google'] as const;
export type MagmaProvider = (typeof MagmaProviders)[number];

export type MagmaClient = OpenAI | Anthropic | Groq | GoogleGenerativeAI;

export type AnthropicModel = Anthropic.Messages.Model;

export type OpenAIModel = ChatModel | (string & {});

export type GroqModel = string & {};

export type GoogleModel = string & {};

export type MagmaModel = AnthropicModel | OpenAIModel | GroqModel | GoogleModel;

export type OpenAIProviderConfig = {
    client?: OpenAI;
    provider: 'openai';
    model: OpenAIModel;
};

export type AnthropicProviderConfig = {
    client?: Anthropic;
    provider: 'anthropic';
    model: AnthropicModel;
};

export type GroqProviderConfig = {
    client?: Groq;
    provider: 'groq';
    model: GroqModel;
};

export type GoogleProviderConfig = {
    client?: GoogleGenerativeAI;
    provider: 'google';
    model: GoogleModel;
};

export type MagmaProviderConfig =
    | OpenAIProviderConfig
    | AnthropicProviderConfig
    | GroqProviderConfig
    | GoogleProviderConfig;
