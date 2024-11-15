export type STTMode = 'vad' | 'manual' | 'none';

export type STTConfig = {
    mode: STTMode;
    sampleRate?: number;
    encoding?: string;
};
