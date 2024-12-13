<div align="center">
<img alt="Magma Framework logo" src="https://db.productdialog.com/storage/v1/object/public/images/magma-header.jpg">
</div>

<br/>

<div align="center"><strong>Turn your workflows into a workforce.</strong></div>
<div align="center">Create and deploy conversational agents without any of the headaches.</div>

<br/>

<div align="center">

[![npm version](https://img.shields.io/npm/v/@pompeii-labs/magma.svg)](https://www.npmjs.com/package/@pompeii-labs/magma)
[![Slack](https://img.shields.io/badge/Slack-4A154B?logo=slack&logoColor=fff)](https://join.slack.com/t/magmacommunity/shared_invite/zt-2tghhq3av-Xn9k9ntwN5ZwqvxbWcfsTg)
[![GitHub stars](https://img.shields.io/github/stars/pompeii-labs/Magma?style=social)](https://github.com/pompeii-labs/magma)

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
- **Hosted**: Deploy your agents in seconds with the MagmaDeploy platform (coming soon)
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

> 🎉 MagmaFlow is currently in private beta! [Join the waitlist](https://magmaflow.dev) to get early access.

## 🛠 Examples

### Add Tools
Tools give your agent the ability to perform actions. Any method decorated with @tool and @toolparam will be available for the agent to use.

**Important Notes**:
- Every tool method must return a string
- Every tool has `call` as a required parameter, which is the `MagmaToolCall` object
- Tools are executed in sequence
```ts
import { MagmaAgent } from "@pompeii-labs/magma";
import { tool, toolparam } from "@pompeii-labs/magma/decorators";

/** Decorate any agent class method with @toolparam or @tool. 
 * @tool is used to define the tool itself
 * @toolparam is used to define the parameters of the tool (key, type, description, required)
 */
class MyAgent extends MagmaAgent {
    @tool({ name: "search_database", description: "Search the database for records" })
    @toolparam({
        key: "query",
        type: "string",
        description: "Search query",
        required: true
    })
    @toolparam({
        key: "filters",
        type: "object",
        properties: [
            { key: "date", type: "string" },
            { key: "category", type: "string", enum: ["A", "B", "C"] }
        ]
    })
    async searchDatabase(call: MagmaToolCall) {
        const { query, filters } = call.fn_args;
        // Implementation
    }
}
```

### Add Middleware
Middleware is a novel concept to Magma. It allows you to add custom logic to your agent before or after a tool is executed.

This is a great way to add custom logging, validation, data sanitization, etc.

**Important Notes**:
- You can have unlimited middleware methods
- Middleware methods must return a string
```ts
import { MagmaAgent } from "@pompeii-labs/magma";
import { middleware } from "@pompeii-labs/magma/decorators";

/**
 * Decorate any agent class method with @middleware to add custom logging, validation, etc.
 * Types: "preCompletion", "onCompletion", "preToolExecution", "onToolExecution"
 */
class MyAgent extends MagmaAgent {

    @middleware("onCompletion")
    async logBeforeCompletion(message) {
        if (message.content.includes("bad word")) {
            return "You just used a bad word, please try again.";
        }
    }
}
```

### Schedule Jobs
Jobs allow you to schedule functions within your agent. Jobs conform to the standard UNIX cron syntax (https://crontab.guru/).
```ts
import { MagmaAgent } from "@pompeii-labs/magma";
import { job } from "@pompeii-labs/magma/decorators";

class MyAgent extends MagmaAgent {
    // Run every day at midnight
    @job("0 0 * * *")
    async dailyCleanup() {
        await this.cleanDatabase();
    }

    // Run every hour with timezone
    @job("0 * * * *", { timezone: "America/New_York" })
    async hourlySync() {
        await this.syncData();
    }
}
```

### Expose Hooks
Hooks allow you to expose your agent as an API. Any method decorated with @hook will be exposed as an endpoint.

**Important Notes**:
- Hooks are exposed at `/hooks/{hook_name}` in the Magma API
- The only parameter to hook functions is the request object, which is an instance of `express.Request`
```ts
import { MagmaAgent } from "@pompeii-labs/magma";
import { hook } from "@pompeii-labs/magma/decorators";
import { Request } from "express";

class MyAgent extends MagmaAgent {

    @hook('notification')
    async handleNotification(req: Request) {
        await this.processNotification(req.body);
    }
}
```

### Use Different Providers
```ts
class Agent extends MagmaAgent {
    constructor() {
        // Use OpenAI (default)
        super({
            providerConfig: {
                provider: "openai",
                model: "gpt-4o"
            }
        });

        // Use Anthropic
        this.setProviderConfig({
            provider: "anthropic",
            model: "claude-3.5-sonnet-20240620"
        });

        // Use Groq
        this.setProviderConfig({
            provider: "groq",
            model: "llama-3.1-70b-versatile"
        });
    }
}
```

### State Management
Every agent has a state object that you can use to store data.

State does not get passed into LLM calls, so it's a good place to store data that you want to persist between calls / sensitive data.
```ts
class MyAgent extends MagmaAgent {
    async setup() {
        // Initialize state
        this.state.set("counter", 0);
        this.state.set("access_token", "1234567890");
    }

    @tool({ name: "increment" })
    async increment() {
        const counter = this.state.get("counter") || 0;
        this.state.set("counter", counter + 1);
        return `Counter is now ${counter + 1}`;
    }

    @tool({ name: "api_call" })
    async apiCall() {
        const access_token = this.state.get("access_token");
        // Make API call
    }
}
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
Event handlers are optional methods that allow you to tack on custom logic to various events in the agent lifecycle.
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
