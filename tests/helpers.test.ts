import { expect, test, describe } from "bun:test";
import {
	parseErrorToError,
	parseErrorToString,
	getMessageText,
	getMessageReasoning,
	TraceAnalyzer
} from "../src/helpers";
import type { MagmaMessage, MagmaAssistantMessage } from "../src/types";

test("parse string to error", () => {
	const stringToThrow = "Error string";

	try {
		throw stringToThrow;
	} catch (e) {
		const parsedError = parseErrorToError(e);

		expect(parsedError).toEqual(new Error(stringToThrow));
	}
});

test("parse object to error", () => {
	const objectToThrow = {
		str: "Nested string",
		bool: true,
		object: {
			desc: "Nested object prop"
		},
		num: 7
	};

	try {
		throw objectToThrow;
	} catch (e) {
		const parsedError = parseErrorToError(e);

		expect(parsedError).toEqual(new Error(JSON.stringify(objectToThrow)));
	}
});

test("parse number to error", () => {
	const numberToThrow = 7;

	try {
		throw numberToThrow;
	} catch (e) {
		const parsedError = parseErrorToError(e);

		expect(parsedError).toEqual(new Error(JSON.stringify(numberToThrow)));
	}
});

test("parse error to error", () => {
	const errorToThrow = new Error("Error message");

	try {
		throw errorToThrow;
	} catch (e) {
		const parsedError = parseErrorToError(e);

		expect(parsedError).toBe(errorToThrow);
	}
});

test("parse error to string", () => {
	const error = new Error("Error text");

	const string = parseErrorToString(error);

	expect(string).toBe("Error text");
});

describe("getMessageText", () => {
	test("returns string content directly", () => {
		const message: MagmaMessage = {
			role: "user",
			content: "Hello world"
		};

		expect(getMessageText(message)).toBe("Hello world");
	});

	test("extracts text from content array", () => {
		const message: MagmaMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "First part" },
				{ type: "text", text: "Second part" }
			]
		};

		expect(getMessageText(message)).toBe("First part\nSecond part");
	});

	test("filters out non-text parts", () => {
		const message: MagmaMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Text content" },
				{ type: "tool-call", toolCallId: "123", toolName: "test", input: {} }
			]
		};

		expect(getMessageText(message)).toBe("Text content");
	});

	test("returns empty string when no text parts", () => {
		const message: MagmaMessage = {
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "123", toolName: "test", input: {} }]
		};

		expect(getMessageText(message)).toBe("");
	});
});

describe("getMessageReasoning", () => {
	test("returns empty string for string content", () => {
		const message: MagmaAssistantMessage = {
			role: "assistant",
			content: "Hello world"
		};

		expect(getMessageReasoning(message)).toBe("");
	});

	test("extracts reasoning from content array", () => {
		const message: MagmaAssistantMessage = {
			role: "assistant",
			content: [
				{ type: "reasoning", text: "First thought" },
				{ type: "reasoning", text: "Second thought" }
			]
		};

		expect(getMessageReasoning(message)).toBe("First thought\nSecond thought");
	});

	test("filters out non-reasoning parts", () => {
		const message: MagmaAssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Response text" },
				{ type: "reasoning", text: "Internal reasoning" }
			]
		};

		expect(getMessageReasoning(message)).toBe("Internal reasoning");
	});

	test("returns empty string when no reasoning parts", () => {
		const message: MagmaAssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Just text" }]
		};

		expect(getMessageReasoning(message)).toBe("");
	});
});

describe("TraceAnalyzer", () => {
	test("getMiddlewareExecutions returns matched spans", () => {
		const trace = [
			{
				type: "middleware" as const,
				phase: "start" as const,
				requestId: "req-1",
				timestamp: 100,
				data: { middleware: "authMiddleware", middlewarePayload: { token: "abc" } }
			},
			{
				type: "middleware" as const,
				phase: "end" as const,
				status: "success" as const,
				requestId: "req-1",
				timestamp: 150,
				data: {
					middleware: "authMiddleware",
					status: "success",
					middlewareResult: { userId: 1 }
				}
			}
		];

		const analyzer = new TraceAnalyzer(trace);
		const executions = analyzer.getMiddlewareExecutions();

		expect(executions).toHaveLength(1);
		expect(executions[0].name).toBe("authMiddleware");
		expect(executions[0].duration).toBe(50);
		expect(executions[0].status).toBe("success");
		expect(executions[0].requestId).toBe("req-1");
	});

	test("getToolExecutions returns matched spans", () => {
		const trace = [
			{
				type: "tool_execution" as const,
				phase: "start" as const,
				requestId: "req-1",
				timestamp: 200,
				data: { toolName: "searchTool", toolCallId: "call-1", args: { query: "test" } }
			},
			{
				type: "tool_execution" as const,
				phase: "end" as const,
				status: "success" as const,
				requestId: "req-1",
				timestamp: 300,
				data: { toolName: "searchTool", status: "success", result: { results: [] } }
			}
		];

		const analyzer = new TraceAnalyzer(trace);
		const executions = analyzer.getToolExecutions();

		expect(executions).toHaveLength(1);
		expect(executions[0].toolName).toBe("searchTool");
		expect(executions[0].duration).toBe(100);
		expect(executions[0].status).toBe("success");
		expect(executions[0].toolCallId).toBe("call-1");
	});

	test("getEventsByRequestId filters events", () => {
		const trace = [
			{
				type: "completion" as const,
				phase: "start" as const,
				requestId: "req-1",
				timestamp: 100,
				data: {}
			},
			{
				type: "completion" as const,
				phase: "start" as const,
				requestId: "req-2",
				timestamp: 200,
				data: {}
			}
		];

		const analyzer = new TraceAnalyzer(trace);
		const events = analyzer.getEventsByRequestId("req-1");

		expect(events).toHaveLength(1);
		expect(events[0].requestId).toBe("req-1");
	});

	test("getEventFlow returns sorted events with details", () => {
		const trace = [
			{
				type: "completion" as const,
				phase: "end" as const,
				status: "success" as const,
				requestId: "req-1",
				timestamp: 200,
				data: {}
			},
			{
				type: "completion" as const,
				phase: "start" as const,
				requestId: "req-1",
				timestamp: 100,
				data: {}
			}
		];

		const analyzer = new TraceAnalyzer(trace);
		const flow = analyzer.getEventFlow();

		expect(flow).toHaveLength(2);
		expect(flow[0].timestamp).toBe(100);
		expect(flow[0].details).toBe("Completion started");
		expect(flow[1].timestamp).toBe(200);
		expect(flow[1].details).toBe("Completion ended with status: success");
	});

	test("getEventFlow returns details for tool execution", () => {
		const trace = [
			{
				type: "tool_execution" as const,
				phase: "start" as const,
				requestId: "req-1",
				timestamp: 100,
				data: { toolName: "myTool" }
			},
			{
				type: "tool_execution" as const,
				phase: "end" as const,
				status: "error" as const,
				requestId: "req-1",
				timestamp: 200,
				data: { toolName: "myTool" }
			}
		];

		const analyzer = new TraceAnalyzer(trace);
		const flow = analyzer.getEventFlow();

		expect(flow[0].details).toBe("Tool execution started: myTool");
		expect(flow[1].details).toBe("Tool execution ended: myTool (error)");
	});

	test("getEventFlow returns details for middleware", () => {
		const trace = [
			{
				type: "middleware" as const,
				phase: "start" as const,
				requestId: "req-1",
				timestamp: 100,
				data: { middleware: "authMiddleware" }
			},
			{
				type: "middleware" as const,
				phase: "end" as const,
				status: "success" as const,
				requestId: "req-1",
				timestamp: 200,
				data: { middleware: "authMiddleware" }
			}
		];

		const analyzer = new TraceAnalyzer(trace);
		const flow = analyzer.getEventFlow();

		expect(flow[0].details).toBe("Middleware started: authMiddleware");
		expect(flow[1].details).toBe("Middleware ended: authMiddleware (success)");
	});

	test("ignores unmatched start events", () => {
		const trace = [
			{
				type: "middleware" as const,
				phase: "start" as const,
				requestId: "req-1",
				timestamp: 100,
				data: { middleware: "orphanMiddleware" }
			}
		];

		const analyzer = new TraceAnalyzer(trace);
		const executions = analyzer.getMiddlewareExecutions();

		expect(executions).toHaveLength(0);
	});

	test("ignores end events without matching start", () => {
		const trace = [
			{
				type: "middleware" as const,
				phase: "end" as const,
				status: "success" as const,
				requestId: "req-1",
				timestamp: 100,
				data: { middleware: "orphanMiddleware", status: "success" }
			}
		];

		const analyzer = new TraceAnalyzer(trace);
		const executions = analyzer.getMiddlewareExecutions();

		expect(executions).toHaveLength(0);
	});
});
