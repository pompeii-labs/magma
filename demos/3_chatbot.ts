import MagmaAgent from '../src';
import readline from 'readline';
import { ANSI, Logger } from '../src/logger';

export async function cliChatbotDemo() {
    // Create your agent - this time we'll use Claude 3.5 sonnet
    const agent = new MagmaAgent({
        providerConfig: {
            provider: 'anthropic',
            model: 'claude-3-5-sonnet-20240620',
        },
    });

    // Let's have a conversation this time
    agent.fetchSystemPrompts = () => [
        {
            role: 'system',
            content: 'Have a conversation with the user about their hobbies. Keep it brief.',
        },
    ];

    // Create a readline interface so we can chat over the command line
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${ANSI.MAGENTA}[Me]${ANSI.RESET} `,
    });

    // Start the conversation
    const firstMsg = await agent.main();
    Logger.main.info(firstMsg.content);

    // Using the readline interface, prompt the user for a reply
    rl.prompt();

    // When we put a message into the terminal, give it to the agent and get the convo going!
    rl.on('line', async (line) => {
        const message = line.trim();

        if (message.toUpperCase() === 'QUIT') {
            rl.close();
        } else {
            agent.addMessage(message);
            const reply = await agent.main();
            Logger.main.info(reply.content);
            rl.prompt();
        }
    });
}
