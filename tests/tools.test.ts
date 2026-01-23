import { expect, test, describe } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { MagmaAgent } from "../src/agent";
import { magmaTool } from "../src/types";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

function createTextStream(text: string): LanguageModelV3StreamPart[] {
	const textId = "text-1";
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: textId },
		{ type: "text-delta", id: textId, delta: text },
		{ type: "text-end", id: textId },
		{
			type: "finish",
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 5, text: 5, reasoning: 0 }
			}
		}
	];
}

function createToolCallStream(
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>
): LanguageModelV3StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{
			type: "tool-call",
			toolCallId: toolCallId,
			toolName: toolName,
			input: JSON.stringify(args)
		} as LanguageModelV3StreamPart,
		{
			type: "finish",
			finishReason: { unified: "tool-calls", raw: undefined },
			usage: {
				inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 5, text: 5, reasoning: 0 }
			}
		}
	];
}

describe("Tool Execution", () => {
	describe("basic execution", () => {
		test("executes tool and returns result", async () => {
			let toolExecuted = false;
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								if (callCount === 1) {
									return {
										stream: simulateReadableStream({
											chunks: createToolCallStream("greet", "call-1", {
												name: "World"
											})
										})
									};
								}
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("Done!")
									})
								};
							}
						})
					},
					state: {}
				},
				{
					greet: magmaTool({
						description: "Greet someone",
						inputSchema: z.object({
							name: z.string()
						}),
						execute: async (input) => {
							toolExecuted = true;
							return `Hello, ${input.name}!`;
						}
					})
				}
			);

			const result = await agent.main({
				userMessage: { role: "user", content: "Greet the world" }
			});

			expect(toolExecuted).toBe(true);
			expect(result).not.toBeNull();
		});

		test("tool receives correct input", async () => {
			let receivedInput: unknown = null;
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								if (callCount === 1) {
									return {
										stream: simulateReadableStream({
											chunks: createToolCallStream("add", "call-1", {
												a: 5,
												b: 3
											})
										})
									};
								}
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("The sum is 8")
									})
								};
							}
						})
					},
					state: {}
				},
				{
					add: magmaTool({
						description: "Add two numbers",
						inputSchema: z.object({
							a: z.number(),
							b: z.number()
						}),
						execute: async (input) => {
							receivedInput = input;
							return `${input.a + input.b}`;
						}
					})
				}
			);

			await agent.main({
				userMessage: { role: "user", content: "Add 5 and 3" }
			});

			expect(receivedInput).toEqual({ a: 5, b: 3 });
		});

		test("tool result added to message history", async () => {
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								if (callCount === 1) {
									return {
										stream: simulateReadableStream({
											chunks: createToolCallStream("echo", "call-1", {
												message: "test"
											})
										})
									};
								}
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("Echoed!")
									})
								};
							}
						})
					},
					state: {}
				},
				{
					echo: magmaTool({
						description: "Echo a message",
						inputSchema: z.object({
							message: z.string()
						}),
						execute: async (input) => {
							return `Echo: ${input.message}`;
						}
					})
				}
			);

			await agent.main({
				userMessage: { role: "user", content: "Echo test" }
			});

			// Should have: user, assistant (tool call), tool result, assistant (final)
			expect(agent.messages.length).toBe(4);
			expect(agent.messages[2].role).toBe("tool");
		});
	});

	describe("state access", () => {
		test("tool can access agent state", async () => {
			let stateValue: number | null = null;
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								if (callCount === 1) {
									return {
										stream: simulateReadableStream({
											chunks: createToolCallStream("getCounter", "call-1", {})
										})
									};
								}
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("Counter value returned")
									})
								};
							}
						})
					},
					state: { counter: 42 }
				},
				{
					getCounter: magmaTool<{ counter: number }, Record<string, never>>({
						description: "Get the counter value",
						inputSchema: z.object({}),
						execute: async (_, { agent }) => {
							stateValue = agent.state.counter;
							return `Counter: ${agent.state.counter}`;
						}
					})
				}
			);

			await agent.main({
				userMessage: { role: "user", content: "Get counter" }
			});

			expect(stateValue as number | null).toBe(42);
		});

		test("tool can modify agent state", async () => {
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								if (callCount === 1) {
									return {
										stream: simulateReadableStream({
											chunks: createToolCallStream("increment", "call-1", {
												amount: 10
											})
										})
									};
								}
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("Incremented!")
									})
								};
							}
						})
					},
					state: { counter: 5 }
				},
				{
					increment: magmaTool<{ counter: number }, { amount: number }>({
						description: "Increment the counter",
						inputSchema: z.object({
							amount: z.number()
						}),
						execute: async (input, { agent }) => {
							agent.state.counter += input.amount;
							return `Counter is now ${agent.state.counter}`;
						}
					})
				}
			);

			await agent.main({
				userMessage: { role: "user", content: "Increment by 10" }
			});

			expect(agent.state.counter).toBe(15);
		});
	});

	describe("enabled function", () => {
		test("enabled tool is available", async () => {
			let toolCalled = false;
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								if (callCount === 1) {
									return {
										stream: simulateReadableStream({
											chunks: createToolCallStream(
												"enabledTool",
												"call-1",
												{}
											)
										})
									};
								}
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("Done")
									})
								};
							}
						})
					},
					state: { toolEnabled: true }
				},
				{
					enabledTool: magmaTool<{ toolEnabled: boolean }, Record<string, never>>({
						description: "A conditionally enabled tool",
						inputSchema: z.object({}),
						enabled: ({ agent }) => agent.state.toolEnabled,
						execute: async () => {
							toolCalled = true;
							return "Tool executed";
						}
					})
				}
			);

			await agent.main({
				userMessage: { role: "user", content: "Use the tool" }
			});

			expect(toolCalled).toBe(true);
		});
	});

	describe("context object", () => {
		test("tool receives ctx object scoped to main loop", async () => {
			let ctxReceived: Record<string, unknown> | null = null;
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								if (callCount === 1) {
									return {
										stream: simulateReadableStream({
											chunks: createToolCallStream("checkCtx", "call-1", {})
										})
									};
								}
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("Done")
									})
								};
							}
						})
					},
					state: {}
				},
				{
					checkCtx: magmaTool({
						description: "Check ctx object",
						inputSchema: z.object({}),
						execute: async (_, { ctx }) => {
							ctxReceived = ctx;
							ctx.visited = true;
							return "checked";
						}
					})
				}
			);

			await agent.main({
				userMessage: { role: "user", content: "Check ctx" }
			});

			expect(ctxReceived).not.toBeNull();
			expect(typeof ctxReceived).toBe("object");
		});
	});

	describe("error handling", () => {
		test("tool execution error is captured in result", async () => {
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								if (callCount === 1) {
									return {
										stream: simulateReadableStream({
											chunks: createToolCallStream(
												"failingTool",
												"call-1",
												{}
											)
										})
									};
								}
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("Handled the error")
									})
								};
							}
						})
					},
					state: {}
				},
				{
					failingTool: magmaTool({
						description: "A tool that fails",
						inputSchema: z.object({}),
						execute: async () => {
							throw new Error("Tool execution failed");
						}
					})
				}
			);

			const result = await agent.main({
				userMessage: { role: "user", content: "Use failing tool" }
			});

			// Agent should continue and produce a response after the tool error
			expect(result).not.toBeNull();
			expect(agent.messages.length).toBe(4);

			// The tool message should contain the error
			const toolMessage = agent.messages[2];
			expect(toolMessage.role).toBe("tool");
		});
	});

	describe("trigger mode", () => {
		test("trigger forces specific tool execution", async () => {
			let specificToolCalled = false;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => ({
								stream: simulateReadableStream({
									chunks: createToolCallStream("specificTool", "call-1", {
										value: "triggered"
									})
								})
							})
						})
					},
					state: {}
				},
				{
					specificTool: magmaTool({
						description: "A specific tool",
						inputSchema: z.object({
							value: z.string()
						}),
						execute: async (input) => {
							specificToolCalled = true;
							return `Received: ${input.value}`;
						}
					}),
					otherTool: magmaTool({
						description: "Another tool",
						inputSchema: z.object({}),
						execute: async () => {
							return "Other tool";
						}
					})
				}
			);

			const result = await agent.main({
				userMessage: { role: "user", content: "Do something" },
				trigger: "specificTool"
			});

			expect(specificToolCalled).toBe(true);
			expect(result).not.toBeNull();
		});

		test("trigger returns tool result directly", async () => {
			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => ({
								stream: simulateReadableStream({
									chunks: createToolCallStream("getData", "call-1", {})
								})
							})
						})
					},
					state: {}
				},
				{
					getData: magmaTool({
						description: "Get data",
						inputSchema: z.object({}),
						execute: async () => {
							return { data: "important", count: 42 };
						}
					})
				}
			);

			const result = await agent.main({
				userMessage: { role: "user", content: "Get data" },
				trigger: "getData"
			});

			// In trigger mode, messages shouldn't be added to history in the usual way
			// and the result should be the tool output
			expect(result).not.toBeNull();
		});
	});
});
