<div align="center">
<img alt="Magma Framework logo" src="https://db.productdialog.com/storage/v1/object/public/images/magma-header.jpg">
</div>

<br/>
<br/>

<div align="center"><strong>A powerful framework for building AI Agents with ease and flexibility.</strong><br> Magma is an open-source framework that simplifies the process of creating, managing, and deploying AI agents for various applications.
<br />
<br />

</div>

<div align="center">

[![npm version](https://img.shields.io/npm/v/@pompeii-labs/magma.svg)](https://www.npmjs.com/package/@pompeii-labs/magma)
[![Discord](https://img.shields.io/discord/1285279452661551145?color=7289da&label=Discord&logo=discord&logoColor=ffffff)](https://discord.gg/NShaQZmhpr)
[![GitHub stars](https://img.shields.io/github/stars/pompeii-labs/Magma?style=social)](https://github.com/pompeii-labs/Magma)

</div>

<br/>

## What is Magma?

Magma is a low-opinion framework allowing developers to focus on the logic and behavior of their agents, rather than dealing with useless abstractions. It gives you greater visibility and control over an agent's process as it occurs.

## Key Features

- Support for multiple AI providers (OpenAI, Anthropic, more to come)
- Flexible tool system for extending agent capabilities
- Middleware support for customizing agent behavior

## Installation

You can install Magma using npm:
```bash
npm i @pompeii-labs/magma
```

## Quick Start

Here's a simple example of creating an AI agent using Magma:

```ts
const agent = new MagmaAgent();

agent.fetchSystemMessages = () => [{ role: 'system', content: 'Welcome the user to the Magma framework by Pompeii Labs' }];

const reply = await agent.main();
console.log('Agent: ' + result.content);
```

### Providers

Magma providers all conform to Magma types, meaning you can now use different LLM providers in the same code without having to do type conversion

```ts
const agent = new MagmaAgent(); // Default provider is OpenAI

const openai = new MagmaAgent({ provider: 'openai', model: 'gpt-o1-mini' });

const anthropic = new MagmaAgent({ provider: 'anthropic', model: 'claude-3-5-sonnet-20240620' });
```

### Class Extensions

The `MagmaAgent` class can be instantiated as-is with `new MagmaAgent` or extended for more custom functionality

```ts
class MyAgent extends MagmaAgent {
    myState: any[] = [];

    constructor() {
        super();
    }

    @tool()
    async myTool();

    @middleware()
    async myMiddleware();
}
```

### Easy Tool Definitions

Use `@tool` and `@toolparam` decorators to tell your agent which methods are tools it has available. These tools can be called by the agent naturally, or force-called using the `agent.trigger(...)` method

```ts
import MagmaAgent from './src/services/magma';

class MyAgent extends MagmaAgent {
    constructor() {
        super();
    }

    @tool({ name: 'greet', description: 'Greet the user' })
    @toolparam({ key: 'name', type: 'string', description: 'Name of the user', required: true })
    async greet(args: { name: string }) {
        return `Hello, ${args.name}!`;
    }
}
```

### Extensible Middleware

With `@middleware` you can define different middleware functions to perform data validation, logging, and other vital operations **during** the agent's process. Now you have complete control over the flow of data, whereas other frameworks leave you in the dark as to what's happening under the hood.

```ts
import MagmaAgent from './src/services/magma';

class MyAgent extends MagmaAgent {
    constructor() {
        super();
    }

    @middleware('preCompletion') // other options include postCompletion, preToolExecution, postToolExecution
    async checkFizzBuzz(message: MagmaMessage) {
        const userMessage = message as MagmaUserMessage;

        if (userMessage.includes('fizz'))
            return 'The user has said fizz, you must respond with the word buzz';
    }
}
```

### Custom State Management

Use `setup(...)` to initialize any asynchronous data or arguments you need to properly manage your agent's state.

```ts
class MyAgent extends MagmaAgent {
    private job: 'project manager' | 'weatherman';

    constructor() {
        super();
    }

    async setup(opts?: { job: string }) {
        if (opts?.job) {
            this.job = opts.job;
        }
    }

    async fetchSystemPrompts(): Promise<MagmaSystemMessage[]> {
        switch (this.job) {
            case 'project manager':
                return [{ role: 'system', content: 'You are a project manager. Keep the team on track' }];
            case 'weatherman':
                return [{ role: 'system', content: 'You are a weather reporter, keep the user up to date on the locations they care about' }];
        }
    }
}
```

# Documentation

For detailed documentation, please visit our [Documentation Page](https://magma.pompeiilabs.com/).

# Examples

Try looking through the examples in the `demos/` folder. You can also clone the repo and run through each demo to get an idea of how to use Magma and how it works.

To run one of the demos, pick one of the approved demo names and run `npm run demo <DEMO_NAME>`.
Available demos:
- hello
- tools
- chatbot
- middleware
- taskMaster

# License

Magma is [Apache 2.0 licensed](LICENSE).
