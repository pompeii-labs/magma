export type TTSClient = 'whisper' | 'elevenlabs' | 'deepgram';
export const TTSClients: Record<string, TTSClient> = {
    WHISPER: 'whisper',
    ELEVENLABS: 'elevenlabs',
    DEEPGRAM: 'deepgram',
} as const;

export type TTSConfig = {
    client: TTSClient;
    voice?: string;
};
