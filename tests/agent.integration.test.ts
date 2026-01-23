import { expect, test, describe } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { MagmaAgent } from "../src/agent";
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

describe("Agent Integration", () => {
	describe("preCompletion middleware", () => {
		test("error is returned as assistant message", async () => {
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
					state: {}
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

			const result = await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

			expect(result).not.toBeNull();
			expect(result?.role).toBe("assistant");
			expect(result?.content).toBe("preCompletion failed");
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
					state: {}
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

			await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

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
					state: {}
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

			const result = await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

			expect(callCount).toBe(2);
			expect(result).not.toBeNull();
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
					state: {}
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

			const result = await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

			expect(callCount).toBe(2);
			expect(result).not.toBeNull();
		});
	});

	describe("onMainFinish middleware", () => {
		test("runs on text completions", async () => {
			let onMainFinishRan = false;

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
					state: {}
				},
				{},
				{
					trackFinish: {
						trigger: "onMainFinish",
						action: async () => {
							onMainFinishRan = true;
						}
					}
				}
			);

			await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

			expect(onMainFinishRan).toBe(true);
		});

		test("error triggers regeneration", async () => {
			let callCount = 0;

			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => {
								callCount++;
								const text = callCount === 1 ? "first" : "second";
								return {
									stream: simulateReadableStream({
										chunks: createTextStream(text)
									})
								};
							}
						})
					},
					state: {}
				},
				{},
				{
					rejectFirst: {
						trigger: "onMainFinish",
						action: async (message) => {
							if (message === "first") {
								throw new Error("Rejected first");
							}
						}
					}
				}
			);

			await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

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

			await agent.main({
				userMessage: { role: "user", content: "Message 4" }
			});

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
				messageContext: -1
			});

			agent.messages = [
				{ role: "user", content: "Message 1" },
				{ role: "assistant", content: "Response 1" },
				{ role: "user", content: "Message 2" },
				{ role: "assistant", content: "Response 2" }
			];

			await agent.main({
				userMessage: { role: "user", content: "Message 3" }
			});

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
				getSystemPrompts: () => [{ role: "system", content: "System prompt" }]
			});

			await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

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
				getSystemPrompts: () => [{ role: "system", content: "Test system prompt" }]
			});

			await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

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
				getSystemPrompts: (info) => {
					receivedAgent = info.agent;
					return [];
				}
			});

			await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

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
				onUsageUpdate: () => {
					usageReceived = true;
				}
			});

			await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

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

			const result = await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

			expect(onErrorCalled).toBe(true);
			expect(errorReceived).not.toBeNull();
			expect(errorReceived!.message).toContain("Catastrophic error");
			expect(result).toBeNull();
		});
	});

	describe("concurrent execution", () => {
		test("multiple main calls can run concurrently", async () => {
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
				state: {}
			});

			await Promise.all([
				agent.main({ userMessage: { role: "user", content: "Request 1" } }),
				agent.main({ userMessage: { role: "user", content: "Request 2" } }),
				agent.main({ userMessage: { role: "user", content: "Request 3" } })
			]);

			expect(maxConcurrent).toBeGreaterThan(1);
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
				state: {}
			});

			const promise = agent.main({ userMessage: { role: "user", content: "Hello" } });

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
				state: {}
			});

			await agent.main({
				userMessage: { role: "user", content: "Hello" }
			});

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
				state: {}
			});

			await agent.main({ userMessage: { role: "user", content: "First" } });
			await agent.main({ userMessage: { role: "user", content: "Second" } });
			await agent.main({ userMessage: { role: "user", content: "Third" } });

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
				state: {}
			});

			await agent.main({
				userMessage: { role: "user", content: "Hello" },
				onTrace: (trace) => {
					traceReceived = trace;
				}
			});

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
					onError: () => {} // Suppress error
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

			await agent.main({
				userMessage: { role: "user", content: "Hello" },
				onTrace: () => {
					traceCalled = true;
				}
			});

			expect(traceCalled).toBe(true);
		});
	});
});
