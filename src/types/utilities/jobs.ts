import { MagmaAgent } from '../../agent';

export interface MagmaJob {
    handler: (agent: MagmaAgent) => Promise<void>;
    schedule: string;
    options?: { timezone?: string };
    name?: string;
}
