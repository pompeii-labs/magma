export type MagmaHook = {
    name: string;
    handler: (payload: any) => Promise<void>;
};
