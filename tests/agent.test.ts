import { expect, test, describe } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { MagmaAgent } from "../src/agent";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

function createTextStreamParts(text: string): LanguageModelV3StreamPart[] {
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

describe("MagmaAgent", () => {
	describe("initialization", () => {
		test("initializes with required props", () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({})
				},
				state: { counter: 0 }
			});

			expect(agent.state).toEqual({ counter: 0 });
			expect(agent.messages).toEqual([]);
			expect(agent.processing).toBe(false);
		});

		test("initializes with tools and middleware", () => {
			const agent = new MagmaAgent(
				{
					llmConfig: {
						model: new MockLanguageModelV3({})
					},
					state: {}
				},
				{
					testTool: {
						description: "A test tool",
						inputSchema: z.object({}),
						execute: async () => "result"
					}
				},
				{
					testMiddleware: {
						trigger: "preCompletion",
						action: async () => {}
					}
				}
			);

			expect(agent.tools).toHaveProperty("testTool");
			expect(agent.middleware).toHaveProperty("testMiddleware");
		});

		test("uses default messageContext of -1", () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({})
				},
				state: {}
			});

			expect(agent.messageContext).toBe(-1);
		});

		test("respects custom messageContext", () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({})
				},
				state: {},
				messageContext: 10
			});

			expect(agent.messageContext).toBe(10);
		});
	});

	describe("main", () => {
		test("returns assistant message for simple text response", async () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({
								chunks: createTextStreamParts("Hello, world!")
							})
						})
					})
				},
				state: {}
			});

			const result = await agent.main({
				userMessage: {
					role: "user",
					content: "Hi"
				}
			});

			expect(result).not.toBeNull();
			expect(result?.role).toBe("assistant");
			expect(Array.isArray(result?.content)).toBe(true);
			const textPart = (result?.content as Array<{ type: string; text?: string }>).find(
				(p) => p.type === "text"
			);
			expect(textPart?.text).toBe("Hello, world!");
		});

		test("adds messages to history after completion", async () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({
								chunks: createTextStreamParts("Response")
							})
						})
					})
				},
				state: {}
			});

			await agent.main({
				userMessage: {
					role: "user",
					content: "Test message"
				}
			});

			expect(agent.messages.length).toBe(2);
			expect(agent.messages[0].role).toBe("user");
			expect(agent.messages[1].role).toBe("assistant");
		});

		test("calls onStreamChunk callback", async () => {
			const chunks: unknown[] = [];
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({
								chunks: createTextStreamParts("Streamed")
							})
						})
					})
				},
				state: {}
			});

			await agent.main({
				userMessage: {
					role: "user",
					content: "Stream test"
				},
				onStreamChunk: (chunk) => {
					chunks.push(chunk);
				}
			});

			expect(chunks.length).toBeGreaterThan(0);
		});

		test("calls onUsageUpdate callback", async () => {
			let capturedUsage: unknown = null;
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({
								chunks: createTextStreamParts("Usage test")
							})
						})
					})
				},
				state: {},
				onUsageUpdate: (usage) => {
					capturedUsage = usage;
				}
			});

			await agent.main({
				userMessage: {
					role: "user",
					content: "Test"
				}
			});

			expect(capturedUsage).not.toBeNull();
		});
	});

	describe("kill", () => {
		test("aborts running requests", async () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({
								chunks: createTextStreamParts("Delayed"),
								initialDelayInMs: 1000
							})
						})
					})
				},
				state: {}
			});

			const promise = agent.main({
				userMessage: {
					role: "user",
					content: "Test"
				}
			});

			expect(agent.processing).toBe(true);

			agent.kill();

			const result = await promise;
			expect(result).toBeNull();
			expect(agent.processing).toBe(false);
		});
	});

	describe("processing", () => {
		test("returns false when no requests are running", () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({})
				},
				state: {}
			});

			expect(agent.processing).toBe(false);
		});
	});

	describe("log", () => {
		test("logs when verbose is true", () => {
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (msg: string) => logs.push(msg);

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({})
				},
				state: {},
				verbose: true
			});

			agent.log("Test message");

			console.log = originalLog;

			expect(logs).toContain("Test message");
		});

		test("does not log when verbose is false", () => {
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (msg: string) => logs.push(msg);

			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({})
				},
				state: {},
				verbose: false
			});

			agent.log("Test message");

			console.log = originalLog;

			expect(logs).not.toContain("Test message");
		});
	});

	describe("system prompts", () => {
		test("uses getSystemPrompts when provided", async () => {
			let capturedInfo: unknown = null;
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({
						doStream: async () => ({
							stream: simulateReadableStream({
								chunks: createTextStreamParts("With system")
							})
						})
					})
				},
				state: { testValue: 42 },
				getSystemPrompts: (info) => {
					capturedInfo = info;
					return [{ role: "system", content: "You are a helpful assistant." }];
				}
			});

			await agent.main({
				userMessage: {
					role: "user",
					content: "Test"
				}
			});

			expect(capturedInfo).not.toBeNull();
			expect((capturedInfo as { agent: typeof agent }).agent).toBe(agent);
		});
	});
});
