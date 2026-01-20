import { ToolModelMessage, ToolResultPart } from "ai";
import { MagmaMiddlewareSet, MagmaToolResult, MagmaToolSet, TraceEvent } from "../types";
import { parseErrorToString } from "../helpers";
import { MagmaAgent } from "../agent";

export async function runOnToolExecutionMiddleware<STATE, TOOLS extends MagmaToolSet<STATE>>({
	agent,
	middleware,
	message,
	trace,
	requestId
}: {
	agent: MagmaAgent<STATE, TOOLS>;
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
					const middlewareResult = (await mdlwr.action(toolResult, {
						state: agent.state
					})) as MagmaToolResult;
					// if the middleware has a return value, we should update the tool result in the result message
					if (middlewareResult !== undefined) {
						resultContent[i] = middlewareResult;
						agent.log(
							`${name} middleware modified tool result block` +
								"\n" +
								`Original: ${JSON.stringify(toolResult, null, 2)}` +
								"\n" +
								`Modified: ${JSON.stringify(middlewareResult, null, 2)}`
						);
					}

					trace.push({
						type: "middleware",
						phase: "end",
						status: "success",
						requestId,
						timestamp: Date.now(),
						data: {
							middleware: name,
							output: middlewareResult
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

					agent.log(`Error in onToolExecution middleware (${name}): ${errorString}`);

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
