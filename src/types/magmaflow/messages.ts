import { MagmaFlowConfig } from './index';
import { MagmaMessage, MagmaStreamChunk, MagmaUsage } from '../messages';

type MagmaFlowMessageMessage = {
    type: 'message';
    agent_id?: string;
    request_id?: string;
    data: MagmaMessage;
};

type MagmaFlowMessageSyncMessage = {
    type: 'message.sync';
    agent_id?: string;
    request_id?: string;
    data: MagmaMessage[];
};

type MagmaFlowErrorMessage = {
    type: 'error';
    agent_id?: string;
    request_id?: string;
    data: Error;
};

type MagmaFlowAudioChunkMessage = {
    type: 'audio.chunk';
    agent_id?: string;
    request_id?: string;
    data: string;
};

type MagmaFlowMessageAudioCommitMessage = {
    type: 'audio.commit';
    agent_id?: string;
    request_id?: string;
    data: {};
};

type MagmaFlowConfigMessage = {
    type: 'config';
    agent_id?: string;
    request_id?: string;
    data: MagmaFlowConfig;
};

type MagmaFlowAbortMessage = {
    type: 'abort';
    agent_id?: string;
    request_id?: string;
    data: {};
};

type MagmaFlowHeartbeatMessage = {
    type: 'heartbeat';
    agent_id?: string;
    request_id?: string;
    data: {};
};

type MagmaFlowLoadingMessage = {
    type: 'loading';
    agent_id?: string;
    request_id?: string;
    data: boolean;
};

type MagmaFlowStreamChunkMessage = {
    type: 'stream.chunk';
    agent_id?: string;
    request_id?: string;
    data: MagmaStreamChunk;
};

type MagmaFlowUsageMessage = {
    type: 'usage';
    agent_id?: string;
    request_id?: string;
    data: MagmaUsage;
};

export type MagmaFlowMessage =
    | MagmaFlowMessageMessage
    | MagmaFlowMessageSyncMessage
    | MagmaFlowErrorMessage
    | MagmaFlowAudioChunkMessage
    | MagmaFlowMessageAudioCommitMessage
    | MagmaFlowConfigMessage
    | MagmaFlowAbortMessage
    | MagmaFlowHeartbeatMessage
    | MagmaFlowLoadingMessage
    | MagmaFlowStreamChunkMessage
    | MagmaFlowUsageMessage;
