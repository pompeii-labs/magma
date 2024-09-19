import MagmaAgent from '../src';
import { Logger } from '../src/logger';
import { MagmaToolTarget } from '../src/types';

/**
 * MagmaToolTarget is the type of function a Magma agent expects to be able to call
 * They receive `args` - an object with the params you've defined
 * They also receive `state`
 *
 * They're expected to return a string, which is the result of the function execution
 */
const fetchLinearTasks: MagmaToolTarget = async (args: Record<string, any>) => {
    return 'Matty has 2 tickets due today on the engineering board, and 3 in marketing';
};

export async function toolDemo() {
    const bot = new MagmaAgent();

    // Define system prompts, which you're already a pro at ;)
    bot.fetchSystemPrompts = () => [{ role: 'system', content: 'You are a Project Manager' }];

    /**
     * NEW - define the tools you want your agent to have available
     * Name, description: self explanatory :)
     * Params: A list of arguments/parameters for the tool call that will be provided to the target function
     * Target: The function you actually want the agent to call!
     */
    bot.fetchTools = () => [
        {
            name: 'fetch_linear_tasks',
            description: 'Fetch the active user\'s tasks in linear',
            params: [
                {
                    key: 'n_days',
                    description: '# of days of linear tasks to fetch',
                    type: 'number',
                },
            ],
            target: fetchLinearTasks,
        },
    ];

    // Use the `trigger()` method to force call a specific function by name!
    const completion = await bot.trigger('fetch_linear_tasks');

    Logger.main.info(completion.content);
}
