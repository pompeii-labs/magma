import MagmaAgent from '../src';
import { Logger } from '../src/logger';

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

    // Agent `main()` method to run a completion for us
    const completion = await bot.main();

    Logger.main.info(completion.content);
}
