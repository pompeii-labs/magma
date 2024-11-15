import { OpenAIModel } from '../providers';
import { AnthropicModel } from '../providers';
import { MagmaSystemMessage } from '../messages';
import { GroqModel } from '../providers';
import { MagmaTool } from '../tools';
import { STTConfig } from './stt';
import { TTSConfig } from './tts';

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
