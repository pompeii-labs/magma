import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'decorators': 'src/decorators.ts',
        'types/index': 'src/types/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    splitting: false,
    treeshake: true,
    external: [
        'ws',
        'openai',
        '@anthropic-ai/sdk',
        '@google/generative-ai',
        'groq-sdk',
    ],
}); 