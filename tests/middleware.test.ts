import { expect, test, describe, mock } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runPreCompletionMiddleware } from "../src/middleware/preCompletion";
import { runOnCompletionMiddleware } from "../src/middleware/onCompletion";
import { runPreToolExecutionMiddleware } from "../src/middleware/preToolExecution";
import { runOnToolExecutionMiddleware } from "../src/middleware/onToolExecution";
import { runOnMainFinishMiddleware } from "../src/middleware/onMainFinish";
import { MagmaAgent } from "../src/agent";
import type { MagmaMiddlewareSet, TraceEvent } from "../src/types";
import type { UserModelMessage, AssistantModelMessage, ToolModelMessage } from "ai";

function createMockInfo() {
	const agent = new MagmaAgent({
		llmConfig: { model: new MockLanguageModelV3({}) },
		state: {}
	});
	return { agent, ctx: {} };
}

describe("runPreCompletionMiddleware", () => {
	test("returns message unchanged when no middleware", async () => {
		const message: UserModelMessage = { role: "user", content: "Hello" };
		const result = await runPreCompletionMiddleware({
			info: createMockInfo(),
			middleware: {},
			message,
			trace: [],
			requestId: "req-1"
		});

		expect(result).toEqual(message);
	});

	test("runs middleware action on text content", async () => {
		const actionFn = mock(async () => {});
		const middleware: MagmaMiddlewareSet = {
			testMiddleware: {
				trigger: "preCompletion",
				action: actionFn
			}
		};

		await runPreCompletionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "user", content: "Test message" },
			trace: [],
			requestId: "req-1"
		});

		expect(actionFn).toHaveBeenCalledTimes(1);
	});

	test("adds trace events on success", async () => {
		const trace: TraceEvent[] = [];
		const middleware: MagmaMiddlewareSet = {
			testMiddleware: {
				trigger: "preCompletion",
				action: async () => {}
			}
		};

		await runPreCompletionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "user", content: "Test" },
			trace,
			requestId: "req-1"
		});

		expect(trace.length).toBe(2);
		expect(trace[0].type).toBe("middleware");
		expect(trace[0].phase).toBe("start");
		expect(trace[1].phase).toBe("end");
		expect(trace[1].phase === "end" && trace[1].status).toBe("success");
	});

	test("throws and adds error trace on middleware failure", async () => {
		const trace: TraceEvent[] = [];
		const middleware: MagmaMiddlewareSet = {
			failingMiddleware: {
				trigger: "preCompletion",
				action: async () => {
					throw new Error("Middleware failed");
				}
			}
		};

		await expect(
			runPreCompletionMiddleware({
				info: createMockInfo(),
				middleware,
				message: { role: "user", content: "Test" },
				trace,
				requestId: "req-1"
			})
		).rejects.toThrow("Middleware failed");

		expect(trace[1].phase === "end" && trace[1].status).toBe("error");
		expect(trace[1].data.error).toBe("Middleware failed");
	});

	test("ignores non-preCompletion middleware", async () => {
		const actionFn = mock(async () => {});
		const middleware: MagmaMiddlewareSet = {
			otherMiddleware: {
				trigger: "onCompletion",
				action: actionFn
			}
		};

		await runPreCompletionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "user", content: "Test" },
			trace: [],
			requestId: "req-1"
		});

		expect(actionFn).not.toHaveBeenCalled();
	});
});

describe("runOnCompletionMiddleware", () => {
	test("returns message unchanged when no middleware", async () => {
		const message: AssistantModelMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Hello" }]
		};

		const result = await runOnCompletionMiddleware({
			info: createMockInfo(),
			middleware: {},
			message,
			trace: [],
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(result).toEqual(message);
	});

	test("clears retry count on success", async () => {
		const middlewareRetries: Record<string, number> = { testMiddleware: 2 };
		const middleware: MagmaMiddlewareSet = {
			testMiddleware: {
				trigger: "onCompletion",
				action: async () => {}
			}
		};

		await runOnCompletionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: "Test" },
			trace: [],
			requestId: "req-1",
			middlewareRetries
		});

		expect(middlewareRetries.testMiddleware).toBeUndefined();
	});

	test("increments retry count on failure", async () => {
		const middlewareRetries: Record<string, number> = {};
		const middleware: MagmaMiddlewareSet = {
			failingMiddleware: {
				trigger: "onCompletion",
				action: async () => {
					throw new Error("Failed");
				}
			}
		};

		await expect(
			runOnCompletionMiddleware({
				info: createMockInfo(),
				middleware,
				message: { role: "assistant", content: "Test" },
				trace: [],
				requestId: "req-1",
				middlewareRetries
			})
		).rejects.toThrow("Failed");

		expect(middlewareRetries.failingMiddleware).toBe(1);
	});

	test("returns null when critical middleware exceeds max retries", async () => {
		const middlewareRetries: Record<string, number> = { criticalMiddleware: 4 };
		const middleware: MagmaMiddlewareSet = {
			criticalMiddleware: {
				trigger: "onCompletion",
				action: async () => {
					throw new Error("Failed");
				},
				critical: true
			}
		};

		const result = await runOnCompletionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: "Test" },
			trace: [],
			requestId: "req-1",
			middlewareRetries
		});

		expect(result).toBeNull();
	});

	test("continues when non-critical middleware exceeds max retries", async () => {
		const middlewareRetries: Record<string, number> = { nonCriticalMiddleware: 4 };
		const middleware: MagmaMiddlewareSet = {
			nonCriticalMiddleware: {
				trigger: "onCompletion",
				action: async () => {
					throw new Error("Failed");
				},
				critical: false
			}
		};

		const result = await runOnCompletionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: "Test" },
			trace: [],
			requestId: "req-1",
			middlewareRetries
		});

		expect(result).not.toBeNull();
		expect(result?.role).toBe("assistant");
	});

	test("respects custom maxRetries", async () => {
		const middlewareRetries: Record<string, number> = { customRetry: 1 };
		const middleware: MagmaMiddlewareSet = {
			customRetry: {
				trigger: "onCompletion",
				action: async () => {
					throw new Error("Failed");
				},
				critical: true,
				maxRetries: 2
			}
		};

		const result = await runOnCompletionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: "Test" },
			trace: [],
			requestId: "req-1",
			middlewareRetries
		});

		expect(result).toBeNull();
	});
});

describe("runPreToolExecutionMiddleware", () => {
	test("returns message unchanged when no middleware", async () => {
		const message: AssistantModelMessage = {
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "1", toolName: "test", input: {} }]
		};

		const result = await runPreToolExecutionMiddleware({
			info: createMockInfo(),
			middleware: {},
			message,
			trace: [],
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(result).toEqual(message);
	});

	test("returns message unchanged when content is string", async () => {
		const message: AssistantModelMessage = {
			role: "assistant",
			content: "Just text"
		};
		const middleware: MagmaMiddlewareSet = {
			testMiddleware: {
				trigger: "preToolExecution",
				action: async () => {}
			}
		};

		const result = await runPreToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message,
			trace: [],
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(result).toEqual(message);
	});

	test("runs middleware on tool-call parts", async () => {
		const actionFn = mock(async () => {});
		const middleware: MagmaMiddlewareSet = {
			testMiddleware: {
				trigger: "preToolExecution",
				action: actionFn
			}
		};
		const toolCall = {
			type: "tool-call" as const,
			toolCallId: "1",
			toolName: "myTool",
			input: { arg: "value" }
		};

		await runPreToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: [toolCall] },
			trace: [],
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(actionFn).toHaveBeenCalledTimes(1);
	});

	test("skips middleware when appliesTo does not include tool", async () => {
		const actionFn = mock(async () => {});
		const middleware: MagmaMiddlewareSet = {
			selectiveMiddleware: {
				trigger: "preToolExecution",
				action: actionFn,
				appliesTo: ["otherTool"]
			}
		};

		await runPreToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message: {
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "1", toolName: "myTool", input: {} }]
			},
			trace: [],
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(actionFn).not.toHaveBeenCalled();
	});

	test("runs middleware when appliesTo includes tool", async () => {
		const actionFn = mock(async () => {});
		const middleware: MagmaMiddlewareSet = {
			selectiveMiddleware: {
				trigger: "preToolExecution",
				action: actionFn,
				appliesTo: ["myTool"]
			}
		};

		await runPreToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message: {
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "1", toolName: "myTool", input: {} }]
			},
			trace: [],
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(actionFn).toHaveBeenCalledTimes(1);
	});

	test("returns null when critical middleware exceeds max retries", async () => {
		const middlewareRetries: Record<string, number> = { criticalMiddleware: 4 };
		const middleware: MagmaMiddlewareSet = {
			criticalMiddleware: {
				trigger: "preToolExecution",
				action: async () => {
					throw new Error("Failed");
				},
				critical: true
			}
		};

		const result = await runPreToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message: {
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "1", toolName: "test", input: {} }]
			},
			trace: [],
			requestId: "req-1",
			middlewareRetries
		});

		expect(result).toBeNull();
	});
});

describe("runOnToolExecutionMiddleware", () => {
	test("returns message unchanged when no middleware", async () => {
		const message: ToolModelMessage = {
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "1",
					toolName: "test",
					output: { type: "text", value: "result" }
				}
			]
		};

		const result = await runOnToolExecutionMiddleware({
			info: createMockInfo(),
			middleware: {},
			message,
			trace: [],
			requestId: "req-1"
		});

		expect(result).toEqual(message);
	});

	test("runs middleware on tool-result parts", async () => {
		const actionFn = mock(async () => {});
		const middleware: MagmaMiddlewareSet = {
			testMiddleware: {
				trigger: "onToolExecution",
				action: actionFn
			}
		};
		const toolResult = {
			type: "tool-result" as const,
			toolCallId: "1",
			toolName: "myTool",
			output: { type: "text" as const, value: "result" }
		};

		await runOnToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "tool", content: [toolResult] },
			trace: [],
			requestId: "req-1"
		});

		expect(actionFn).toHaveBeenCalledTimes(1);
	});

	test("skips middleware when appliesTo does not include tool", async () => {
		const actionFn = mock(async () => {});
		const middleware: MagmaMiddlewareSet = {
			selectiveMiddleware: {
				trigger: "onToolExecution",
				action: actionFn,
				appliesTo: ["otherTool"]
			}
		};

		await runOnToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message: {
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "1",
						toolName: "myTool",
						output: { type: "text", value: "result" }
					}
				]
			},
			trace: [],
			requestId: "req-1"
		});

		expect(actionFn).not.toHaveBeenCalled();
	});

	test("sets error output on middleware failure instead of throwing", async () => {
		const middleware: MagmaMiddlewareSet = {
			failingMiddleware: {
				trigger: "onToolExecution",
				action: async () => {
					throw new Error("Middleware error");
				}
			}
		};

		const result = await runOnToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message: {
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "1",
						toolName: "test",
						output: { type: "text", value: "original" }
					}
				]
			},
			trace: [],
			requestId: "req-1"
		});

		const toolResult = result.content[0];
		expect(toolResult.type === "tool-result" && toolResult.output).toEqual({
			type: "error-text",
			value: "Middleware error"
		});
	});

	test("adds error trace on middleware failure", async () => {
		const trace: TraceEvent[] = [];
		const middleware: MagmaMiddlewareSet = {
			failingMiddleware: {
				trigger: "onToolExecution",
				action: async () => {
					throw new Error("Middleware error");
				}
			}
		};

		await runOnToolExecutionMiddleware({
			info: createMockInfo(),
			middleware,
			message: {
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "1",
						toolName: "test",
						output: { type: "text", value: "result" }
					}
				]
			},
			trace,
			requestId: "req-1"
		});

		expect(trace[1].phase === "end" && trace[1].status).toBe("error");
		expect(trace[1].data.error).toBe("Middleware error");
	});
});

describe("runOnMainFinishMiddleware", () => {
	test("returns message unchanged when no middleware", async () => {
		const message: AssistantModelMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Done" }]
		};

		const result = await runOnMainFinishMiddleware({
			info: createMockInfo(),
			middleware: {},
			message,
			trace: [],
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(result).toEqual(message);
	});

	test("runs middleware action on text content", async () => {
		const actionFn = mock(async () => {});
		const middleware: MagmaMiddlewareSet = {
			testMiddleware: {
				trigger: "onMainFinish",
				action: actionFn
			}
		};

		await runOnMainFinishMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: "Final response" },
			trace: [],
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(actionFn).toHaveBeenCalledTimes(1);
	});

	test("returns null when critical middleware exceeds max retries", async () => {
		const middlewareRetries: Record<string, number> = { criticalMiddleware: 4 };
		const middleware: MagmaMiddlewareSet = {
			criticalMiddleware: {
				trigger: "onMainFinish",
				action: async () => {
					throw new Error("Failed");
				},
				critical: true
			}
		};

		const result = await runOnMainFinishMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: "Test" },
			trace: [],
			requestId: "req-1",
			middlewareRetries
		});

		expect(result).toBeNull();
	});

	test("continues when non-critical middleware exceeds max retries", async () => {
		const middlewareRetries: Record<string, number> = { nonCriticalMiddleware: 4 };
		const middleware: MagmaMiddlewareSet = {
			nonCriticalMiddleware: {
				trigger: "onMainFinish",
				action: async () => {
					throw new Error("Failed");
				},
				critical: false
			}
		};

		const result = await runOnMainFinishMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: "Test" },
			trace: [],
			requestId: "req-1",
			middlewareRetries
		});

		expect(result).not.toBeNull();
	});

	test("adds trace events", async () => {
		const trace: TraceEvent[] = [];
		const middleware: MagmaMiddlewareSet = {
			testMiddleware: {
				trigger: "onMainFinish",
				action: async () => {}
			}
		};

		await runOnMainFinishMiddleware({
			info: createMockInfo(),
			middleware,
			message: { role: "assistant", content: "Test" },
			trace,
			requestId: "req-1",
			middlewareRetries: {}
		});

		expect(trace.length).toBe(2);
		expect(trace[0].phase).toBe("start");
		expect(trace[1].phase).toBe("end");
		expect(trace[1].phase === "end" && trace[1].status).toBe("success");
	});
});
