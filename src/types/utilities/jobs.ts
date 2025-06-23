import { MagmaAgent } from '../../agent';

export interface MagmaJob {
    handler: (agent: MagmaAgent) => Promise<void> | void;
    schedule: string;
    options?: { timezone?: string };
    name?: string;
}
