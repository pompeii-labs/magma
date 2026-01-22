import { ToolModelMessage, ToolResultPart } from "ai";
import { MagmaInfo, MagmaMiddlewareSet, MagmaToolSet, TraceEvent } from "../types";
import { parseErrorToString } from "../helpers";

export async function runOnToolExecutionMiddleware<STATE, TOOLS extends MagmaToolSet<STATE>>({
	info,
	middleware,
	message,
	trace,
	requestId
}: {
	info: MagmaInfo<STATE, TOOLS>;
	middleware: MagmaMiddlewareSet<STATE, TOOLS>;
	message: ToolModelMessage;
	trace: TraceEvent[];
	requestId: string;
}): Promise<ToolModelMessage> {
	// get onToolExecution middleware
	const allMiddleware = Object.entries(middleware);
	const onToolExecutionMiddleware = allMiddleware.filter(
		([_, m]) => m.trigger === "onToolExecution"
	);
	if (onToolExecutionMiddleware.length === 0) return message;

	const contentToRun = message.content;

	// initialize result content
	const resultContent = [];

	// go through the blocks of the incoming message
	for (let i = 0; i < contentToRun.length; i++) {
		// add the block to the result message
		resultContent.push(contentToRun[i]);
		// if the block is a tool result, we should run each middleware on it
		if (resultContent[i].type === "tool-result") {
			const toolResult = resultContent[i] as ToolResultPart;
			for (const [name, mdlwr] of onToolExecutionMiddleware) {
				try {
					trace.push({
						type: "middleware",
						phase: "start",
						requestId,
						timestamp: Date.now(),
						data: {
							middleware: name,
							input: toolResult.output
						}
					});
					// check if the middleware is supposed to run for this tool call
					if (
						mdlwr.appliesTo !== undefined &&
						!mdlwr.appliesTo.includes(toolResult.toolName)
					) {
						// this middleware should not run on this tool call
						continue;
					}
					// run the middleware on the tool result
					await mdlwr.action(toolResult, info);

					trace.push({
						type: "middleware",
						phase: "end",
						status: "success",
						requestId,
						timestamp: Date.now(),
						data: {
							middleware: name
						}
					});
				} catch (error) {
					const errorString = parseErrorToString(error);

					trace.push({
						type: "middleware",
						phase: "end",
						status: "error",
						requestId,
						timestamp: Date.now(),
						data: {
							middleware: name,
							toolName: toolResult.toolName,
							result: toolResult,
							error: errorString
						}
					});

					info.agent.log(`Error in onToolExecution middleware (${name}): ${errorString}`);

					toolResult.output = { type: "error-text", value: errorString };
				}
			}
		}
	}

	// return the result message
	return {
		role: "tool",
		content: resultContent
	};
}
