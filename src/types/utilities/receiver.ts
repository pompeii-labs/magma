import { MagmaAgent } from '../../agent';
import { MagmaSendFunction } from '../agent';

export type MagmaReceiver = {
    handler: (
        wsMessage: string,
        send: MagmaSendFunction,
        agent: MagmaAgent
    ) => Promise<void> | void;
    shouldHandle: (data: string) => boolean;
};
