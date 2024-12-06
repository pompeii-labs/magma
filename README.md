<div align="center">
<img alt="Magma Framework logo" src="https://db.productdialog.com/storage/v1/object/public/images/magma-header.jpg">
</div>

<br/>

<div align="center"><strong>Build AI agents in 5 minutes, not 5 days.</strong></div>
<div align="center">After trying all of the popular frameworks in the last year, we felt they were all far too complex. So we built Magma.</div>

<br/>

<div align="center">

[![npm version](https://img.shields.io/npm/v/@pompeii-labs/magma.svg)](https://www.npmjs.com/package/@pompeii-labs/magma)
[![Slack](https://img.shields.io/badge/Slack-4A154B?logo=slack&logoColor=fff)](https://join.slack.com/t/magmacommunity/shared_invite/zt-2tghhq3av-Xn9k9ntwN5ZwqvxbWcfsTg)
[![GitHub stars](https://img.shields.io/github/stars/pompeii-labs/Magma?style=social)](https://github.com/pompeii-labs/Magma)

</div>

## 🌋 What is Magma?

Magma is a framework that lets you create AI agents without the headache. No complex chains, no confusing abstractions - just write the logic you want your agent to have.

Want to try it out? [Chat with Dialog](https://chat.productdialog.com/ac94ab36-c5bb-4b54-a195-2b6b2499dcff), our user research agent built with Magma!

## ⚡️ Quick Start

1. Install Magma:
```bash
npm i @pompeii-labs/magma
```

2. Create your first agent:
```ts
import { MagmaAgent } from "@pompeii-labs/magma";

// That's it! You've got a working agent
const agent = new MagmaAgent();

// Want to give it some personality? Add system prompts:
agent.fetchSystemPrompts = () => [{
    role: "system",
    content: "You are a friendly assistant who loves dad jokes"
}];

// Need the agent to do something? Add tools:
agent.fetchTools = () => [{
    name: "tell_joke",
    description: "Tell a dad joke",
    target: async () => {
        return "Why don't eggs tell jokes? They'd crack up! 🥚";
    }
}];

// Run it:
const reply = await agent.main();
console.log(reply.content);
```

## 🔥 Key Features

- **Simple**: Build agents in minutes with minimal code
- **Flexible**: Use any AI provider (OpenAI, Anthropic, Groq)
- **Powerful**: Add tools and middleware when you need them
- **Observable**: See exactly what your agent is doing

## 🚀 MagmaFlow

Want even more power? MagmaFlow gives you instant access to:
- Voice input/output
- Streaming responses
- Tool execution
- Usage tracking
- And more!

```ts
const agent = new MagmaAgent({
    apiKey: "mf_..." // Get your key at magmaflow.dev
});
```

> 🎉 MagmaFlow is currently in private beta! [Join the waitlist](https://magmaflow.pompeiilabs.com) to get early access.

## 🛠 Examples

### Add Tools
```ts
import { MagmaAgent, toolparam } from "@pompeii-labs/magma";

/** Decorate any agent class method with @toolparam or @tool. 
 * @tool is used to define the tool itself
 * @toolparam is used to define the parameters of the tool (key, type, description, required)
 */
class MyAgent extends MagmaAgent {

    @toolparam({ key: 'city', type: 'string' })
    async getWeather({ city }) {
        return `It's sunny in ${city}! 🌞`;
    }
}
```

### Add Middleware
```ts
import { MagmaAgent, middleware } from "@pompeii-labs/magma";

/**
 * Decorate any agent class method with @middleware to add custom logging, validation, etc.
 * Types: "preCompletion", "onCompletion", "preToolExecution", "onToolExecution"
 */
class MyAgent extends MagmaAgent {

    @middleware("preCompletion")
    async logBeforeCompletion(message) {
        console.log("About to generate a response!");
    }
}
```

### Use Different Providers
```ts
// Use OpenAI (default)
const openai = new MagmaAgent();

// Use Anthropic
const claude = new MagmaAgent({
    providerConfig: {
        provider: "anthropic",
        model: "claude-3.5-sonnet-20240620"
    }
});

// Use Groq
const groq = new MagmaAgent({
    providerConfig: {
        provider: "groq",
        model: "llama-3.1-70b-versatile"
    }
});
```

### Core Methods
```ts
import { MagmaAgent } from "@pompeii-labs/magma";

class MyAgent extends MagmaAgent {
    // Initialize your agent
    async setup() {
        // Load resources, connect to databases, etc.
        await this.loadDatabase();
        return "I'm ready to help!";
    }

    // Handle incoming messages
    async receive(message: any) {
        // Process user input before main() is called
        if (message.type === 'image') {
            await this.processImage(message.content);
        }
    }

    // Clean up resources
    async cleanup();

    // Manually trigger a specific tool
    async trigger({ name: "get_weather" });

    // Stop the current execution
    kill();
}
```

### Event Handlers
```ts
import { MagmaAgent } from "@pompeii-labs/magma";

class MyAgent extends MagmaAgent {
    // Handle agent shutdown
    async onCleanup() {
        console.log("Agent shutting down...");
    }

    // Handle errors
    async onError(error: Error) {
        console.error("Something went wrong:", error);
        await this.notifyAdmin(error);
    }

    // Track token usage
    async onUsageUpdate(usage: MagmaUsage) {
        await this.saveUsageMetrics(usage);
    }

    // Process streaming responses
    async onStreamChunk(chunk: MagmaStreamChunk) {
        console.log("Received chunk:", chunk.content);
    }

    // MagmaFlow Handlers
    async onConnect() {
        console.log("Connected to MagmaFlow!");
    }

    // Handle agent disconnection from MagmaFlow
    async onDisconnect() {
        console.log("Disconnected from MagmaFlow");
    }

    // Handle incoming audio chunks
    async onAudioChunk(chunk: Buffer) {
        // Process incoming audio
        await this.processAudioChunk(chunk);
    }

    // Handle audio stream completion
    async onAudioCommit() {
        // Audio stream complete
        await this.finalizeAudioProcessing();
    }

    // Handle request abortion
    async onAbort() {
        await this.cleanup();
    }
}
```

## 📚 Want More?

- Join our [Slack Community](https://join.slack.com/t/magmacommunity/shared_invite/zt-2tghhq3av-Xn9k9ntwN5ZwqvxbWcfsTg)
- Star us on [GitHub](https://github.com/pompeii-labs/magma)

## 📝 License

Magma is [Apache 2.0 licensed](LICENSE).
