import { MagmaAgent } from '../../agent';
import { MagmaSendFunction } from '../agent';

export type MagmaWSMessage = {
    type: string;
    data: unknown;
};

export type MagmaReceiver = {
    handler: (
        wsMessage: MagmaWSMessage,
        send: MagmaSendFunction,
        agent: MagmaAgent
    ) => Promise<void> | void;
    shouldHandle: (data: string) => boolean;
};
