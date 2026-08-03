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
				state: { counter: 0 },
				onMessage: async () => {}
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
					state: {},
					onMessage: async () => {}
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
				state: {},
				onMessage: async () => {}
			});

			expect(agent.messageContext).toBe(-1);
		});

		test("respects custom messageContext", () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({})
				},
				state: {},
				onMessage: async () => {},
				messageContext: 10
			});

			expect(agent.messageContext).toBe(10);
		});
	});

	describe("run", () => {
		test("emits assistant message for simple text response", async () => {
			const events: unknown[] = [];
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
				state: {},
				onMessage: async (message) => {
					events.push(message);
				}
			});

			await agent.run("Hi");

			expect(events).toHaveLength(1);
			const event = events[0] as {
				role: string;
				content: Array<{ type: string; text?: string }>;
			};
			expect(event.role).toBe("assistant");
			const textPart = event.content.find((p) => p.type === "text");
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
				state: {},
				onMessage: async () => {}
			});

			await agent.run("Test message");

			expect(agent.messages.length).toBe(2);
			expect(agent.messages[0].role).toBe("user");
			expect(agent.messages[1].role).toBe("assistant");
		});

		test("accepts structured user content", async () => {
			const content = [
				{
					type: "text" as const,
					text: "Structured input",
					providerOptions: {
						anthropic: {
							cacheControl: { type: "ephemeral" }
						}
					}
				}
			];
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
				state: {},
				onMessage: async () => {}
			});

			await agent.run(content);

			expect(agent.messages[0]).toEqual({
				role: "user",
				content
			});
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
				state: {},
				onMessage: async () => {},
				onStreamChunk: (chunk) => {
					chunks.push(chunk);
				}
			});

			await agent.run("Stream test");

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
				onMessage: async () => {},
				onUsageUpdate: (usage) => {
					capturedUsage = usage;
				}
			});

			await agent.run("Test");

			expect(capturedUsage).not.toBeNull();
		});
	});

	describe("kill", () => {
		test("aborts running requests without unhandled AI SDK rejections", async () => {
			const unhandledRejections: unknown[] = [];
			const onUnhandledRejection = (reason: unknown) => {
				unhandledRejections.push(reason);
			};
			const caughtTicketErrors: unknown[] = [];
			process.on("unhandledRejection", onUnhandledRejection);

			try {
				let killed = false;
				let historyAfterKill: unknown[] = [];
				const agent = new MagmaAgent({
					llmConfig: {
						model: new MockLanguageModelV3({
							doStream: async () => ({
								stream: simulateReadableStream({
									chunks: createTextStreamParts("Delayed"),
									initialDelayInMs: 20,
									chunkDelayInMs: 10
								})
							})
						})
					},
					state: {},
					onMessage: async () => {},
					onStreamChunk: () => {
						if (killed) return;
						killed = true;
						agent.kill();
						historyAfterKill = [...agent.messages];
					}
				});

				const firstPromise = agent.run("Test").catch((error) => {
					caughtTicketErrors.push(error);
				});
				const steeringPromise = agent.run("Steer").catch((error) => {
					caughtTicketErrors.push(error);
				});

				await Promise.all([firstPromise, steeringPromise]);
				await new Promise((resolve) => setTimeout(resolve, 20));

				expect(killed).toBe(true);
				expect(agent.processing).toBe(false);
				expect(historyAfterKill).toEqual([]);
				expect(agent.messages).toEqual([]);
				expect(
					caughtTicketErrors.every(
						(error) => error instanceof Error && error.name === "AbortError"
					)
				).toBe(true);
				expect(caughtTicketErrors).toHaveLength(2);
				expect(unhandledRejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandledRejection);
			}
		});
	});

	describe("processing", () => {
		test("returns false when no requests are running", () => {
			const agent = new MagmaAgent({
				llmConfig: {
					model: new MockLanguageModelV3({})
				},
				state: {},
				onMessage: async () => {}
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
				onMessage: async () => {},
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
				onMessage: async () => {},
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
				onMessage: async () => {},
				getSystemPrompts: (info) => {
					capturedInfo = info;
					return [{ role: "system", content: "You are a helpful assistant." }];
				}
			});

			await agent.run("Test");

			expect(capturedInfo).not.toBeNull();
			expect((capturedInfo as { agent: typeof agent }).agent).toBe(agent);
		});
	});
});
