import MagmaAgent from '../src';
import readline from 'readline';
import { ANSI, Logger } from '../src/logger';

export async function middlewareDemo() {
    const agent = new MagmaAgent({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20240620',
    });

    agent.fetchSystemPrompts = () => [
        {
            role: 'system',
            content: 'Have a conversation with the user about their hobbies. Keep it brief.',
        },
    ];

    /**
     * NEW - middleware
     * Middleware in Magma is essentially a function you can run in the middle of 
     * an agent process so you can have some manual intervention.
     * 
     * Rather than having a completion be a black box, now you can have some say!
     *
     * Middleware types: before/after completion generation, before/after tool execution
     *
     * Examples:
     * - Sanitize personal data from a user message before generating completion
     * - Validate Agent completion doesn't violate company guidelines/policies
     * - Check tool call data for hallucinations before executing call
     *
     * Using middleware you can either return a string when you detect an issue, as more of a 'heads up'
     * OR you can throw an error to indicate higher severity to the model during its next task
     */
    agent.fetchMiddleware = () => [
        // Middleware to validate a user's message before generating the reply
        {
            trigger: 'preCompletion',
            async action(args) {
                if (args.content.toLowerCase().includes('fizz')) {
                    Logger.main.warn(
                        'preCompletion middleware detected an issue with user message',
                    );

                    return 'The user said "fizz". You must reply with the word "buzz"';
                }
            },
        },
        // Middleware to validate the agent's message before returning
        {
            trigger: 'onCompletion',
            async action(args) {
                if (args.content.toLowerCase().includes('ai')) {
                    Logger.main.warn('onCompletion middleware detected an issue, retrying');

                    return 'DO NOT USE THE WORD AI IN YOUR MESSAGES';
                }
            },
        },
    ];

    // Again, creating a CLI interface
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${ANSI.MAGENTA}[Me]${ANSI.RESET} `,
    });

    const firstMsg = await agent.main();
    Logger.main.info(firstMsg.content);

    rl.prompt();

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
