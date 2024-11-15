import { OpenAIModel, AnthropicModel } from '../providers.js';
import { MagmaSystemMessage } from '../messages.js';
import { GroqModel } from '../providers.js';
import { MagmaTool } from '../tools.js';
import { STTConfig } from './stt.js';
import { TTSConfig } from './tts.js';

export type MagmaFlowProviderConfig =
    | {
          provider?: 'openai';
          model?: OpenAIModel;
      }
    | {
          provider?: 'anthropic';
          model?: AnthropicModel;
      }
    | {
          provider?: 'groq';
          model?: GroqModel;
      };

export type MagmaFlowConfig = {
    system_prompts?: MagmaSystemMessage[];
    tools?: Omit<MagmaTool, 'target'>[];
    agent_id?: string;
    tts?: TTSConfig;
    stt?: STTConfig;
} & MagmaFlowProviderConfig;
