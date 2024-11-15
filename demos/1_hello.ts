import MagmaAgent from '../src/index.js';
import { Logger } from '../src/logger.js';

export async function helloWorld() {
    // Create new MagmaAgent
    const bot = new MagmaAgent();

    // Define system prompt getter method
    bot.fetchSystemPrompts = () => [
        {
            role: 'system',
            content: 'Welcome the user to the Magma AI Agent framework, developed by Pompeii Labs.',
        },
    ];

    bot.setProviderConfig({ provider: 'openai', model: 'chatgpt-4o-latest' });

    // Agent `main()` method to run a completion for us
    const completion = await bot.main();

    Logger.main.info(completion.content);
}
