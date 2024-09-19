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

We at Pompeii have been building agents since the release of GPT-4. Over the last year and a half, we've tried every 

Magma is a framework designed to streamline the development of AI agents. It provides a set of tools and abstractions that allow developers to focus on the logic and behavior of their agents, rather than the underlying infrastructure.

## Key Features

- Support for multiple AI providers (OpenAI, Anthropic, more to come)
- Flexible tool system for extending agent capabilities
- Middleware support for customizing agent behavior

## Installation

You can install Magma using npm:

```bash
npm install @pompeii-labs/magma
```

## Quick Start

Here's a simple example of creating an AI agent using Magma:

```ts
import MagmaAgent from './src/services/magma';

class MyAgent extends MagmaAgent {
    constructor() {
        super({
            provider: 'openai',
            model: 'gpt-4',
        });
    }

    @tool({ name: 'greet', description: 'Greet the user' })
    @toolparam({ key: 'name', type: 'string', description: 'Name of the user' })
    async greet(args: { name: string }) {
        return `Hello, ${args.name}!`;
    }
}

const agent = new MyAgent();
await agent.setup();
const result = await agent.trigger('greet');
console.log(result);
```

### Providers

```ts
const openAIAgent = new MagmaAgent({
    provider: 'openai',
    model: 'gpt-4o',
});

const anthropicAgent = new MagmaAgent({
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20240620',
});
```

### Class Extensions for Custom State Management

```ts
class MyAgent extends MagmaAgent {
    private job: 'project manager' | 'weatherman';
    constructor() {
        super({
            provider: 'openai',
            model: 'gpt-4o',
        });
    }

    async setup(opts?: { job: string }) {
        if (opts?.job) {
            this.job = opts.job;
        }}
    }

    async fetchSystemPrompts(): Promise<MagmaSystemMessage[]> {
        switch (job) {
            case 'project manager':
                return [{ role: 'system', content: 'You are a project manager. Keep the team on track' }];
            case 'weatherman':
                return [{ role: 'system', content: 'You are a weather reporter, keep the user up to date on the locations they care about' }];
        }
    }
}
```

### Easy Tool Definitions

```ts
import MagmaAgent from './src/services/magma';

class MyAgent extends MagmaAgent {
    constructor() {
        super({
            provider: 'openai',
            model: 'gpt-4',
        });
    }

    @tool({ name: 'greet', description: 'Greet the user' })
    @toolparam({ key: 'name', type: 'string', description: 'Name of the user', required: true })
    async greet(args: { name: string }) {
        return `Hello, ${args.name}!`;
    }
}
```

### Extensible Middleware

```ts
import MagmaAgent from './src/services/magma';

class MyAgent extends MagmaAgent {
    constructor() {
        super({
            provider: 'openai',
            model: 'gpt-4',
        });
    }

    @middleware('preCompletion') // other options include postCompletion, preToolExecution, postToolExecution
    async checkFizzBuzz(message: MagmaMessage) {
        const userMessage = message as MagmaUserMessage;

        if (userMessage.includes('fizz'))
            return 'The user has said fizz, you must respond with the word buzz';
    }
}
```

## Documentation

For detailed documentation, please visit our [Documentation Page](https://magma.pompeiilabs.com/).

## Examples

Try looking through the examples in the demos folder. You can also clone the repo and run through each demo to get an idea of how to use Magma and how it works.

## License

Magma is [Apache 2.0 licensed](LICENSE).
