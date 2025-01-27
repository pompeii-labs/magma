export interface MagmaJob {
    handler: () => Promise<void>;
    schedule: string;
    options?: { timezone?: string };
}
