<div align="center">
<img alt="Magma Framework logo" src="https://db.productdialog.com/storage/v1/object/public/images/magma-header.jpg">
</div>

<br/>

<div align="center"><strong>Lightweight AI agent framework built on the Vercel AI SDK.</strong></div>

<br/>

<div align="center">

[![npm version](https://img.shields.io/npm/v/@pompeii-labs/magma.svg)](https://www.npmjs.com/package/@pompeii-labs/magma)
[![GitHub stars](https://img.shields.io/github/stars/pompeii-labs/Magma?style=social)](https://github.com/pompeii-labs/magma)

</div>

## What is Magma?

Magma is a lightweight framework for building AI agents. It provides a simple abstraction over the Vercel AI SDK with built-in support for tools, middleware, and state management.

## Quick Start

```bash
npm i @pompeii-labs/magma
```

```ts
import { MagmaAgent } from "@pompeii-labs/magma";
import { anthropic } from "@ai-sdk/anthropic";

const agent = new MagmaAgent({
	llmConfig: {
		model: anthropic("claude-sonnet-4-20250514")
	},
	state: {},
	getSystemPrompts: () => [{ role: "system", content: "You are a helpful assistant." }]
});

const response = await agent.main({
	userMessage: { role: "user", content: "Hello!" }
});
```

## Tools

Tools give your agent the ability to perform actions. Define them with a Zod schema for type-safe inputs.

```ts
import { z } from "zod";

const agent = new MagmaAgent(
	{
		llmConfig: { model: anthropic("claude-sonnet-4-20250514") },
		state: { count: 0 }
	},
	{
		increment: {
			description: "Increment the counter",
			inputSchema: z.object({
				amount: z.number().describe("Amount to increment by")
			}),
			execute: async (input, { agent }) => {
				agent.state.count += input.amount;
				return `Counter is now ${agent.state.count}`;
			}
		}
	}
);
```

## Middleware

Middleware lets you intercept and modify the agent's behavior at different points in the execution flow.

| Trigger            | Runs On           | Error Behavior             |
| ------------------ | ----------------- | -------------------------- |
| `preCompletion`    | User message      | Returns error as response  |
| `onCompletion`     | Assistant message | Triggers regeneration      |
| `preToolExecution` | Tool calls        | Triggers regeneration      |
| `onToolExecution`  | Tool results      | Replaces output with error |
| `onMainFinish`     | Final response    | Triggers regeneration      |

```ts
const agent = new MagmaAgent(
	{
		llmConfig: { model: anthropic("claude-sonnet-4-20250514") },
		state: {}
	},
	{}, // tools
	{
		contentFilter: {
			trigger: "onCompletion",
			action: async (message, { agent }) => {
				if (message.includes("forbidden")) {
					throw new Error("Response contained forbidden content");
				}
			},
			critical: true,
			maxRetries: 3
		}
	}
);
```

### Middleware Options

- `trigger`: When the middleware runs
- `action`: The function to execute
- `critical`: If true, exhausting retries throws an error. If false, continues normally
- `maxRetries`: Number of regeneration attempts allowed (default: 5)
- `appliesTo`: For tool middleware, array of tool names to run on
- `order`: Execution order when multiple middleware share a trigger (lower first)

## State Management

State is passed to the agent constructor and accessible in tools and middleware via the `info` object.

```ts
const agent = new MagmaAgent({
	llmConfig: { model: anthropic("claude-sonnet-4-20250514") },
	state: {
		userId: "123",
		preferences: { theme: "dark" }
	}
});

// In tools/middleware: info.agent.state.userId
```

## Configuration

```ts
const agent = new MagmaAgent({
	llmConfig: {
		model: anthropic("claude-sonnet-4-20250514"),
		general: {
			temperature: 0.7,
			maxTokens: 1000
		}
	},
	state: {},

	// System prompts called on every completion
	getSystemPrompts: (info) => [
		{ role: "system", content: `User ID: ${info.agent.state.userId}` }
	],

	// Limit message history sent to LLM (-1 for all)
	messageContext: 20,

	// Callbacks
	onUsageUpdate: (usage, info) => console.log(usage),
	onError: (error) => console.error(error),

	// Enable logging
	verbose: true
});
```

## Trigger Mode

Force the agent to call a specific tool and return its result:

```ts
const result = await agent.main({
	userMessage: { role: "user", content: "Get the weather" },
	trigger: "getWeather"
});
```

## Streaming

```ts
await agent.main({
	userMessage: { role: "user", content: "Hello!" },
	onStreamChunk: (chunk, info) => {
		process.stdout.write(chunk.text || "");
	}
});
```

## Tracing

```ts
await agent.main({
	userMessage: { role: "user", content: "Hello!" },
	onTrace: (trace) => {
		console.log("Trace:", trace);
	}
});
```

## Aborting

```ts
// Stop all running requests
agent.kill();

// Check if agent is processing
if (agent.processing) {
	agent.kill();
}
```

## Extending Agents

To create reusable agent functionality while preserving type inference, use a factory function pattern:

```ts
import { MagmaAgent, MagmaAgentProps } from "@pompeii-labs/magma";
import { MagmaMiddlewareSet, MagmaToolSet } from "@pompeii-labs/magma/types";

interface TrackedAgentContext {
	orgId?: string;
	userId?: string;
}

function createTrackedAgent<
	STATE extends Record<string, unknown>,
	TOOLS extends MagmaToolSet<STATE>
>(
	agentType: string,
	config: Omit<MagmaAgentProps<STATE, TOOLS>, "tools" | "middleware">,
	tools: TOOLS,
	middleware?: MagmaMiddlewareSet<STATE, TOOLS>
) {
	// Tracking state lives in closure, not in agent state
	let context: TrackedAgentContext = {};
	const logs: string[] = [];

	const agent = new MagmaAgent<STATE, TOOLS>(
		{
			...config,
			onUsageUpdate: (usage, info) => {
				config.onUsageUpdate?.(usage, info);
				// Track usage here
			}
		},
		tools,
		{
			_log: {
				trigger: "onCompletion",
				order: 1000,
				action: (message) => {
					if (typeof message === "string") {
						logs.push(`[${agentType}] ${message.slice(0, 100)}`);
					}
				}
			},
			...middleware
		} as MagmaMiddlewareSet<STATE, TOOLS>
	);

	return Object.assign(agent, {
		setContext(ctx: TrackedAgentContext) {
			context = { ...context, ...ctx };
		},
		getContext: () => context,
		getLogs: () => logs,
		async cleanup() {
			// Flush logs to database, etc.
		}
	});
}
```

Usage with full type inference:

```ts
const agent = createTrackedAgent(
	"MyAgent",
	{
		llmConfig: { model: anthropic("claude-sonnet-4-20250514") },
		state: { count: 0 }
	},
	{
		increment: {
			description: "Increment counter",
			inputSchema: z.object({ amount: z.number() }),
			execute: async (input, { agent }) => {
				// ✅ input.amount is typed as number
				// ✅ agent.state.count is typed as number
				agent.state.count += input.amount;
				return `Count: ${agent.state.count}`;
			}
		}
	}
);

// ✅ All agent methods available
await agent.main({ userMessage: { role: "user", content: "Increment by 5" } });

// ✅ Extended methods available
agent.setContext({ orgId: "123" });
await agent.cleanup();
```

This pattern works because type inference happens at the call site of `createTrackedAgent`, not at class declaration time.

## License

Magma is [Apache 2.0 licensed](LICENSE).
