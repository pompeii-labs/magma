import MagmaAgent from '../src';
import { tool, toolparam } from '../src/decorators';
import { ANSI, Logger } from '../src/logger';
import { MagmaAssistantMessage, MagmaSystemMessage, MagmaMiddleware } from '../src/types';
import readline from 'readline';

// Define mock task data structure
interface Task {
    id: number;
    title: string;
    completed: boolean;
}

/**
 * Here we're going to extend the MagmaAgent class, rather than creating one inline
 *
 * This gives us greater flexibility in how we define our tools and middleware
 */
class TaskMaster extends MagmaAgent {
    tasks: Task[];

    constructor() {
        // messageContext of -1 is essentially infinity - no limit on how many messages are used in completions
        super({
            messageContext: -1,
            providerConfig: {
                provider: 'anthropic',
                model: 'claude-3-5-sonnet-20240620',
            },
        });

        this.tasks = [];
    }

    /**
     * Can be overridden from the base class to perform any asynchronous setup activities
     * Examples:
     * - Initial message generation
     * - Data retrieval
     * - Checking user authentication
     * - Websocket setup
     */
    public async setup(opts?: object): Promise<MagmaAssistantMessage | void> {
        this.tasks = await this.getTasks();

        return await this.main();
    }

    /**
     * Similar to `setup`, this is optional but a helpful one to override!
     * Can be used to receive data from the command line, a websocket, API call, etc.
     *
     * @param message any message/data schema you want to receive
     */
    public async receive(message: any): Promise<void> {
        // Add user message into context
        this.addMessage(message, 'user');

        // Create reply and print it out
        const reply = await this.main();
        Logger.main.info(reply.content);
    }

    // Override
    fetchSystemPrompts(): MagmaSystemMessage[] {
        const prompts = [
            {
                role: 'system',
                content:
                    'You are a project manager helping the user manage their tasks and prioritize them.',
            },
        ];

        if (this.tasks.length > 0) {
            prompts.push({
                role: 'system',
                content: `Here are the available tasks currently: ${JSON.stringify(this.tasks, null, 4)}`,
            });
        }

        return prompts as MagmaSystemMessage[];
    }

    // Override
    fetchMiddleware(): MagmaMiddleware[] {
        return [
            {
                trigger: 'preToolExecution',
                async action(args) {
                    Logger.main.debug(`⚙️ ${args.fn_name}`);
                },
            },
        ];
    }

    // @tool decorator: optionally define a name and description for the function itself
    // If you don't provide one, the name of the actual function will be used as the tool name
    // @toolparam is essentially defining an argument to your function in a tool schema. No more JSON!
    @tool({ name: 'create_task' })
    @toolparam({ key: 'title', type: 'string', description: 'A grabbing title for the new task' })
    async createTask(args: Record<string, any>): Promise<string> {
        // Create new task with incremented id and generated title
        this.tasks.push({
            id: Math.max(...this.tasks.map((t) => t.id)) + 1,
            title: args.title,
            completed: false,
        });

        // Magma tools are expected to return strings, which can be context for the agent's next message
        return 'Successfully created task. Updated list - ' + JSON.stringify(this.tasks);
    }

    // You can have as many tool params as you want
    // Each one will appear in the `args` to your function!
    @toolparam({ key: 'id', type: 'number' })
    @toolparam({ key: 'completed', type: 'boolean', required: false })
    @toolparam({ key: 'title', type: 'string', required: false })
    async updateTask(args: Record<string, any>): Promise<string> {
        const { id } = args;

        if (!id) throw new Error('No id was provided to updateTask fxn');

        const task = (this.tasks = this.tasks.map((taskToUpdate) => {
            if (taskToUpdate.id === id) {
                return {
                    ...taskToUpdate,
                    ...args,
                };
            } else {
                return taskToUpdate;
            }
        }));

        return `Successfully updated task ${id} | ${JSON.stringify(task)}`;
    }

    @toolparam({ key: 'id', type: 'number' })
    async deleteTask(args: Record<string, any>): Promise<string> {
        const { id } = args;
        this.tasks = this.tasks.filter((f) => f.id !== id);

        return 'Success';
    }

    async getTasks(): Promise<Task[]> {
        return [
            {
                id: 1,
                title: 'Commit all changes',
                completed: true,
            },
            {
                id: 2,
                title: 'Force push to main',
                completed: false,
            },
            {
                id: 3,
                title: 'Delete production db',
                completed: false,
            },
        ];
    }
}

export async function taskMasterDemo() {
    const tm = new TaskMaster();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${ANSI.MAGENTA}[Me]${ANSI.RESET} `,
    });

    // Setup TaskMaster agent and print out the first message
    const conversationStarter = await tm.setup();
    conversationStarter && Logger.main.info(conversationStarter.content);

    rl.prompt();

    rl.on('line', async (line) => {
        const message = line.trim();

        if (message.toUpperCase() === 'QUIT') {
            rl.close();
        } else {
            await tm.receive(message);
            rl.prompt();
        }
    });
}
