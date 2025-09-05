import { DecoratedExtras } from '.';

export type MagmaReceiver = {
    handler: (wsMessage: string, extras: Omit<DecoratedExtras, 'ctx'>) => Promise<void> | void;
    shouldHandle: (data: string) => boolean;
};
