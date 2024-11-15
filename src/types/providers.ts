import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import OpenAI from 'openai';
import { ChatModel } from 'openai/resources/index';

export const MagmaProviders = ['openai', 'anthropic', 'groq'] as const;
export type MagmaProvider = (typeof MagmaProviders)[number];

export type MagmaClient = OpenAI | Anthropic;

export type AnthropicModel = Anthropic.Messages.Model;

export type OpenAIModel = ChatModel;

export type GroqModel = string & {};

export type MagmaModel = AnthropicModel | OpenAIModel | GroqModel;

export type MagmaProviderConfig =
    | {
          client?: OpenAI;
          provider: 'openai';
          model: OpenAIModel;
      }
    | {
          client?: Anthropic;
          provider: 'anthropic';
          model: AnthropicModel;
      }
    | {
          client?: Groq;
          provider: 'groq';
          model: GroqModel;
      };
