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

function createToolCallStream(toolName: string, toolCallId: string): LanguageModelV3StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{
			type: "tool-call",
			toolCallId,
			toolName,
			input: "{}"
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

describe("Agent Integration", () => {
	describe("preCompletion middleware", () => {
		test("error is returned as assistant message", async () => {
			const events: unknown[] = [];
			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => ({
								stream: simulateReadableStream({
									chunks: createTextStream("Should not see this")
								})
							})
						})
					},
					state: {},
					onMessage: async (message) => {
						events.push(message);
					}
				},
				{},
				{
					failingPreCompletion: {
						trigger: "preCompletion",
						action: async () => {
							throw new Error("preCompletion failed");
						}
					}
				}
			);

			await agent.run("Hello");

			expect(events).toEqual([{ role: "assistant", content: "preCompletion failed" }]);
		});

		test("messages not added to history on error", async () => {
			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => ({
								stream: simulateReadableStream({
									chunks: createTextStream("Response")
								})
							})
						})
					},
					state: {},
					onMessage: async () => {}
				},
				{},
				{
					failingPreCompletion: {
						trigger: "preCompletion",
						action: async () => {
							throw new Error("Failed");
						}
					}
				}
			);

			await agent.run("Hello");

			expect(agent.messages.length).toBe(0);
		});
	});

	describe("onCompletion middleware", () => {
		test("error triggers regeneration with error context", async () => {
			let callCount = 0;
			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								const text = callCount === 1 ? "bad response" : "good response";
								return {
									stream: simulateReadableStream({
										chunks: createTextStream(text)
									})
								};
							}
						})
					},
					state: {},
					onMessage: async () => {}
				},
				{},
				{
					rejectBad: {
						trigger: "onCompletion",
						action: async (message) => {
							if (message === "bad response") {
								throw new Error("Response was bad");
							}
						}
					}
				}
			);

			await agent.run("Hello");

			expect(callCount).toBe(2);
		});

		test("non-critical middleware continues after max retries", async () => {
			let callCount = 0;
			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("Response")
									})
								};
							}
						})
					},
					state: {},
					onMessage: async () => {}
				},
				{},
				{
					alwaysFails: {
						trigger: "onCompletion",
						action: async () => {
							throw new Error("Always fails");
						},
						critical: false,
						maxRetries: 2
					}
				}
			);

			await agent.run("Hello");

			expect(callCount).toBe(2);
		});
	});

	describe("messageContext", () => {
		test("slices messages sent to LLM", async () => {
			let receivedMessageCount = 0;

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async (options) => {
							receivedMessageCount = options.prompt.filter(
								(m) => m.role !== "system"
							).length;
							return {
								stream: simulateReadableStream({
									chunks: createTextStream("Response")
								})
							};
						}
					})
				},
				state: {},
				onMessage: async () => {},
				messageContext: 2
			});

			// Add some history
			agent.messages = [
				{ role: "user", content: "Message 1" },
				{ role: "assistant", content: "Response 1" },
				{ role: "user", content: "Message 2" },
				{ role: "assistant", content: "Response 2" },
				{ role: "user", content: "Message 3" },
				{ role: "assistant", content: "Response 3" }
			];

			await agent.run("Message 4");

			expect(receivedMessageCount).toBe(2);
		});

		test("messageContext -1 sends all messages", async () => {
			let receivedMessageCount = 0;

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async (options) => {
							receivedMessageCount = options.prompt.filter(
								(m) => m.role !== "system"
							).length;
							return {
								stream: simulateReadableStream({
									chunks: createTextStream("Response")
								})
							};
						}
					})
				},
				state: {},
				onMessage: async () => {},
				messageContext: -1
			});

			agent.messages = [
				{ role: "user", content: "Message 1" },
				{ role: "assistant", content: "Response 1" },
				{ role: "user", content: "Message 2" },
				{ role: "assistant", content: "Response 2" }
			];

			await agent.run("Message 3");

			// 4 existing + 1 new = 5
			expect(receivedMessageCount).toBe(5);
		});
	});

	describe("getSystemPrompts", () => {
		test("not stored in message history", async () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({ chunks: createTextStream("Response") })
						})
					})
				},
				state: {},
				onMessage: async () => {},
				getSystemPrompts: () => [{ role: "system", content: "System prompt" }]
			});

			await agent.run("Hello");

			const systemMessages = agent.messages.filter((m) => m.role === "system");
			expect(systemMessages.length).toBe(0);
		});

		test("included in prompt to LLM", async () => {
			let systemPromptIncluded = false;

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async (options) => {
							systemPromptIncluded = options.prompt.some(
								(m) => m.role === "system" && m.content === "Test system prompt"
							);
							return {
								stream: simulateReadableStream({
									chunks: createTextStream("Response")
								})
							};
						}
					})
				},
				state: {},
				onMessage: async () => {},
				getSystemPrompts: () => [{ role: "system", content: "Test system prompt" }]
			});

			await agent.run("Hello");

			expect(systemPromptIncluded).toBe(true);
		});

		test("receives info with agent reference", async () => {
			let receivedAgent: unknown = null;

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({ chunks: createTextStream("Response") })
						})
					})
				},
				state: { testValue: 123 },
				onMessage: async () => {},
				getSystemPrompts: (info) => {
					receivedAgent = info.agent;
					return [];
				}
			});

			await agent.run("Hello");

			expect(receivedAgent).toBe(agent);
			expect((receivedAgent as { state: { testValue: number } }).state.testValue).toBe(123);
		});
	});

	describe("onUsageUpdate", () => {
		test("called after completion", async () => {
			let usageReceived = false;

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({ chunks: createTextStream("Response") })
						})
					})
				},
				state: {},
				onMessage: async () => {},
				onUsageUpdate: () => {
					usageReceived = true;
				}
			});

			await agent.run("Hello");

			expect(usageReceived).toBe(true);
		});
	});

	describe("onError", () => {
		test("called when critical middleware fails after max retries", async () => {
			let onErrorCalled = false;
			let errorReceived: Error | null = null;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => ({
								stream: simulateReadableStream({
									chunks: createTextStream("Response")
								})
							})
						})
					},
					state: {},
					onMessage: async () => {},
					onError: (error) => {
						onErrorCalled = true;
						errorReceived = error;
					}
				},
				{},
				{
					criticalMiddleware: {
						trigger: "onCompletion",
						action: async () => {
							throw new Error("Critical failure");
						},
						critical: true,
						maxRetries: 1
					}
				}
			);

			let rejectedError: Error | null = null;
			try {
				await agent.run("Hello");
			} catch (error) {
				rejectedError = error as Error;
			}

			expect(onErrorCalled).toBe(true);
			expect(errorReceived).not.toBeNull();
			expect(errorReceived!.message).toContain("Catastrophic error");
			expect(rejectedError?.message).toContain("Catastrophic error");
			expect(agent.messages).toEqual([]);
		});
	});

	describe("steering execution", () => {
		test("multiple run calls share one completion", async () => {
			let concurrentCalls = 0;
			let maxConcurrent = 0;

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => {
							concurrentCalls++;
							maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
							await new Promise((resolve) => setTimeout(resolve, 10));
							concurrentCalls--;
							return {
								stream: simulateReadableStream({
									chunks: createTextStream("Response")
								})
							};
						}
					})
				},
				state: {},
				onMessage: async () => {}
			});

			await Promise.all([
				agent.run("Request 1"),
				agent.run("Request 2"),
				agent.run("Request 3")
			]);

			expect(maxConcurrent).toBe(1);
			expect(agent.messages.map((message) => message.role)).toEqual([
				"user",
				"user",
				"user",
				"assistant"
			]);
		});

		test("steering during tool execution is inserted after the tool result", async () => {
			let completionCount = 0;
			let chunks = 0;
			const emittedRoles: string[] = [];
			let releaseTool!: () => void;
			let signalToolStarted!: () => void;
			const toolStarted = new Promise<void>((resolve) => {
				signalToolStarted = resolve;
			});
			const toolReleased = new Promise<void>((resolve) => {
				releaseTool = resolve;
			});
			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								completionCount++;
								return {
									stream: simulateReadableStream({
										chunks:
											completionCount === 1
												? createToolCallStream("wait", "call-1")
												: createTextStream("Done")
									})
								};
							}
						})
					},
					state: {},
					onMessage: async (message) => {
						emittedRoles.push(message.role);
					},
					onStreamChunk: () => {
						chunks++;
					}
				},
				{
					wait: magmaTool({
						description: "Wait for the test",
						inputSchema: z.object({}),
						execute: async () => {
							signalToolStarted();
							await toolReleased;
							return "finished";
						}
					})
				}
			);

			const first = agent.run("Start the tool");
			await toolStarted;
			const steering = agent.run("Use this new instruction");
			releaseTool();

			await Promise.all([first, steering]);

			expect(agent.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"tool",
				"user",
				"assistant"
			]);
			expect(chunks).toBeGreaterThan(0);
			expect(emittedRoles).toEqual(["assistant", "tool", "assistant"]);
		});

		test("kill preserves a completed tool exchange and removes trailing steering", async () => {
			let completionCount = 0;
			let killed = false;
			let releaseTool!: () => void;
			let signalToolStarted!: () => void;
			const toolStarted = new Promise<void>((resolve) => {
				signalToolStarted = resolve;
			});
			const toolReleased = new Promise<void>((resolve) => {
				releaseTool = resolve;
			});
			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								completionCount++;
								return {
									stream: simulateReadableStream({
										chunks:
											completionCount === 1
												? createToolCallStream("wait", "call-1")
												: createTextStream("Done")
									})
								};
							}
						})
					},
					state: {},
					onMessage: async () => {},
					onStreamChunk: () => {
						if (completionCount !== 2 || killed) return;
						killed = true;
						agent.kill();
					}
				},
				{
					wait: magmaTool({
						description: "Wait for the test",
						inputSchema: z.object({}),
						execute: async () => {
							signalToolStarted();
							await toolReleased;
							return "finished";
						}
					})
				}
			);

			const first = agent.run("Start the tool").catch(() => {});
			await toolStarted;
			const steering = agent.run("Use this new instruction").catch(() => {});
			releaseTool();

			await Promise.all([first, steering]);

			expect(killed).toBe(true);
			expect(agent.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"tool"
			]);
		});

		test("steering after a terminal completion belongs to the next turn", async () => {
			let completionCount = 0;
			let signalFirstStarted!: () => void;
			let releaseSecond!: () => void;
			let steeringSettled = false;
			const firstStarted = new Promise<void>((resolve) => {
				signalFirstStarted = resolve;
			});
			const secondReleased = new Promise<void>((resolve) => {
				releaseSecond = resolve;
			});
			const events: unknown[] = [];
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => {
							completionCount++;
							if (completionCount === 1) {
								signalFirstStarted();
								return {
									stream: simulateReadableStream({
										chunks: createTextStream("First response"),
										initialDelayInMs: 20
									})
								};
							}
							await secondReleased;
							return {
								stream: simulateReadableStream({
									chunks: createTextStream("Second response")
								})
							};
						}
					})
				},
				state: {},
				onMessage: async (message) => {
					events.push(message);
				}
			});

			const first = agent.run("First request");
			await firstStarted;
			const steering = agent.run("Steering request").then(() => {
				steeringSettled = true;
			});

			await first;
			expect(steeringSettled).toBe(false);
			expect(events).toHaveLength(1);

			releaseSecond();
			await steering;

			expect(events).toHaveLength(2);
			expect(agent.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant"
			]);
		});

		test("processing is true during execution", async () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => {
							await new Promise((resolve) => setTimeout(resolve, 20));
							return {
								stream: simulateReadableStream({
									chunks: createTextStream("Response")
								})
							};
						}
					})
				},
				state: {},
				onMessage: async () => {}
			});

			const promise = agent.run("Hello");

			// Give it a moment to start
			await new Promise((resolve) => setTimeout(resolve, 5));

			expect(agent.processing).toBe(true);

			await promise;

			expect(agent.processing).toBe(false);
		});
	});

	describe("message history", () => {
		test("user and assistant messages added to history", async () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({ chunks: createTextStream("Response") })
						})
					})
				},
				state: {},
				onMessage: async () => {}
			});

			await agent.run("Hello");

			expect(agent.messages.length).toBe(2);
			expect(agent.messages[0].role).toBe("user");
			expect(agent.messages[1].role).toBe("assistant");
		});

		test("multiple calls accumulate history", async () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({ chunks: createTextStream("Response") })
						})
					})
				},
				state: {},
				onMessage: async () => {}
			});

			await agent.run("First");
			await agent.run("Second");
			await agent.run("Third");

			expect(agent.messages.length).toBe(6);
		});
	});

	describe("tracing", () => {
		test("onTrace receives trace events", async () => {
			let traceReceived: unknown[] = [];

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({ chunks: createTextStream("Response") })
						})
					})
				},
				state: {},
				onMessage: async () => {},
				onTrace: (trace) => {
					traceReceived = trace;
				}
			});

			await agent.run("Hello");

			expect(Array.isArray(traceReceived)).toBe(true);
		});

		test("onTrace called even on error", async () => {
			let traceCalled = false;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => ({
								stream: simulateReadableStream({
									chunks: createTextStream("Response")
								})
							})
						})
					},
					state: {},
					onMessage: async () => {},
					onError: () => {}, // Suppress error
					onTrace: () => {
						traceCalled = true;
					}
				},
				{},
				{
					criticalMiddleware: {
						trigger: "onCompletion",
						action: async () => {
							throw new Error("Fail");
						},
						critical: true,
						maxRetries: 1
					}
				}
			);

			try {
				await agent.run("Hello");
			} catch {
				// Critical middleware failures reject the call.
			}

			expect(traceCalled).toBe(true);
		});
	});
});
