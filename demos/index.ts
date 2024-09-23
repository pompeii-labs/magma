import { Logger } from '../src/logger';
import { helloWorld } from './1_hello';
import { cliChatbotDemo } from './3_chatbot';
import { middlewareDemo } from './4_middleware';
import { toolDemo } from './2_tools';
import { taskMasterDemo } from './5_taskMaster';

const demos = ['hello', 'tools', 'chatbot', 'middleware', 'taskmaster'] as const;
type Demo = (typeof demos)[number];

(async () => {
    try {
        const demo = process.argv[2] as Demo;
        if (!demos) throw new Error('Must provide a demo to run');

        switch (demo.toLowerCase()) {
        case 'hello':
            return await helloWorld();
        case 'tools':
            return await toolDemo();
        case 'chatbot':
            return await cliChatbotDemo();
        case 'middleware':
            return await middlewareDemo();
        case 'taskmaster':
            return await taskMasterDemo();
        default:
            throw new Error(`${demo} is not a supported Magma demo`);
        }
    } catch (error) {
        Logger.main.error(error.message ?? 'Unknown');
    }
})();

/**
 * DEMOS
 *  1. Basic agent completion
 *  2. Basic tool call
 *  3. CLI Chatbot
 *  4. How does middleware work?
 *  5. Full agent - Task Master
 */
