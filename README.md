# Magma Framework

<div align="center">
<img alt="Magma Framework logo" width="128" height="128" src="https://db.productdialog.com/storage/v1/object/public/images/magma-m.webp">
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

## Installation

You can install Magma using npm:

```bash
npm install @pompeii-labs/magma
```

## Documentation

For detailed documentation, please visit our [Documentation Page](https://magma.pompeiilabs.com/).

## Examples

Try looking through the examples in the demos folder. You can also clone the repo and run through each demo to get an idea of how to use Magma and how it works.

## License

Magma is [Apache 2.0 licensed](LICENSE).
