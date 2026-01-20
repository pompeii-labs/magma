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

// Magma Agents are class based, so you can extend them with your own methods
class MyAgent extends MagmaAgent {
	// Want to give it some personality? Add system prompts:
	getSystemPrompts() {
		return [
			{
				role: "system",
				content: "You are a friendly assistant who loves dad jokes"
			}
		];
	}
}

// That's it! You've got a working agent
const myAgent = new MyAgent();

// Run it:
const reply = await myAgent.main({ userMessage: { role: "user", content: "Hello world!" } });
console.log(getMessageText(reply));
```

## 🔥 Key Features

- **Simple**: Build agents in minutes with minimal code
- **Flexible**: Use any AI provider through OpenRouter
- **Hosted**: Deploy your agents in seconds with the [MagmaDeploy platform](https://magmadeploy.com)
- **Powerful**: Add tools and middleware when you need them
- **Observable**: See exactly what your agent is doing

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

		const results = await this.searchDatabase(query, filters);

		return "Here are the results of your search: " + JSON.stringify(results);
	}
}
```

### Add Middleware

Middleware is a novel concept to Magma. It allows you to add custom logic to your agent before or after a tool is executed.

This is a great way to add custom logging, validation, data sanitization, etc.

**Types**:

- "preCompletion": Runs before the LLM call is made, takes in the user message as a string
- "onCompletion": Runs after the agent generates a text response, takes in the assistant message as a string
- "preToolExecution": Runs before a tool is executed, takes in a MagmaToolCall
- "onToolExecution": Runs after a tool is executed, takes in a MagmaToolResult
- "onMainFinish": Runs on the last assistant completion in a main loop, takes in the final assistant message as a string

**Important Notes**:

- You can have unlimited middleware methods
- You can return from middleware methods to modify the message being passed in
- Middleware methods can throw errors to adjust the flow of the agent

**Modification Handling**

- If preCompletion middleware returns a string, the user message is replaced by that string and the flow continues. This change applies to the message history as well
- If onCompletion middleware returns a string, the assistant message is replaced by that string and the flow continues. This change applies to the message history as well
- If preToolExecution middleware returns a MagmaToolCall, the original tool call is replaced by the new one and the flow continues. This change applies to the message history as well
- If onToolExecution middleware returns a MagmaToolResult, the original tool result is replaced by the new one and the flow continues. This change applies to the message history as well
- If onMainFinish middleware returns a string, the original string is replaced by that string and is returned as the final string from main. This change DOES NOT apply to the message history

**Error Handling**:

- If preCompletion middleware throws an error, the error message is supplied as if it were the assistant message. The user and assistant messages are also removed from the conversation history
- If onCompletion middleware throws an error, the error message is supplied to the LLM, and it tries to regenerate a response. The assistant message is not added to the conversation history until no error is thrown
- If preToolExecution middleware throws an error, the error message is supplied to the LLM, and it tries to generate a response. The tool call message is not added to the conversation history until no error is thrown
- If onToolExecution middleware throws an error, the error message is supplied as if it were the response from the tool
- If onMainFinish middleware throws an error, the error message is supplied to the LLM, and it tries to regenerate a response. The assistant message is not added to the conversation history until no error is thrown

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
			throw new Error("You just used a bad word, please try again.");
		}
	}
}
```

### Schedule Jobs

Jobs allow you to schedule functions within your agent. Jobs conform to the standard UNIX cron syntax (https://crontab.guru/).

**Important Notes**:

- Jobs do not take in any parameters, and they do not return anything.

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

You can call `agent.scheduleJobs()` to schedule the jobs.
_Note_: Agents deployed on magmadeploy will automatically schedule their jobs, and this function should not be called.

### Expose Hooks

Hooks allow you to expose your agent as an API. Any method decorated with @hook will be exposed as an endpoint.

**Important Notes**:

- Hooks are static methods, so they can run without instantiating the agent.
- Hooks are exposed at `/hooks/{hook_name}` in the Magma API
- Hook functions take in the request and response objects, which use the types from `express`

```ts
import { MagmaAgent } from "@pompeii-labs/magma";
import { hook } from "@pompeii-labs/magma/decorators";
import { Request, Response } from "express";

class MyAgent extends MagmaAgent {
	@hook("notification")
	static async handleNotification(req: Request, res: Response) {
		await this.processNotification(req.body);
		res.sendStatus(200);
	}
}
```

### Use Different Providers

You can use any provider supported by openrouter by setting the config

**Important Notes**:

- You can set the config in the constructor, or set it manually
- You do not need to adjust any of your tools, middleware, jobs, or hooks to use a different provider

```ts
class Agent extends MagmaAgent {
	constructor() {
		// Use OpenAI (default)
		super({
			openrouter: {
				models: ["openai/gpt-4o"]
			}
		});

		// Use Anthropic
		this.config = {
			openrouter: {
				models: ["anthropic/claude-sonnet-4"]
			}
		};
	}
}
```

### State Management

You can declare fields on the class and access them inside your tools, hooks, jobs, and middleware normally.

```ts
class MyAgent extends MagmaAgent {
	// Using a field to store data
	myQuery: string;
	counter: number;

	async setup() {
		this.myQuery = "Hello, World!";
		this.counter = 0;
	}

	@tool({ description: "Increment the counter" })
	async increment() {
		this.counter++;
		return `Counter is now ${this.counter}`;
	}

	@tool({ name: "api_call" })
	async apiCall() {
		const response = await fetch("https://myapi.com/data", {
			body: JSON.stringify({
				query: this.myQuery
			})
		});

		return JSON.stringify(response.json());
	}
}
```

### Initialization

```ts
import { MagmaAgent } from "@pompeii-labs/magma";

class MyAgent extends MagmaAgent {
	// Initialize your agent with potentially asyncronous operations
	async setup() {
		// Load resources, connect to databases, etc.
		await this.loadDatabase();
	}
}
```

### Event Handlers

Event handlers are optional methods that allow you to tack on custom logic to various events in the agent lifecycle.

```ts
import { MagmaAgent } from "@pompeii-labs/magma";

class MyAgent extends MagmaAgent {
	// handle websocket connection close
	async onWsClose(code: number, reason?: string): Promise<void> {}

	// handle agent shutdown
	async onCleanup(): Promise<void> {}

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
		console.log("Received chunk:", JSON.stringify(chunk));
	}
}
```

## 📚 Want More?

- Join our [Slack Community](https://join.slack.com/t/magmacommunity/shared_invite/zt-2tghhq3av-Xn9k9ntwN5ZwqvxbWcfsTg)
- Star us on [GitHub](https://github.com/pompeii-labs/magma)

## 📝 License

Magma is [Apache 2.0 licensed](LICENSE).
