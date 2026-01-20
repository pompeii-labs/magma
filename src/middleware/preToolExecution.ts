import { AssistantModelMessage, ToolCallPart } from "ai";
import { MagmaMiddlewareSet, MagmaToolCall, MagmaToolSet, TraceEvent } from "../types";
import { MagmaAgent, MagmaCtx } from "../agent";
import { parseErrorToString } from "../helpers";

export async function runPreToolExecutionMiddleware<STATE, TOOLS extends MagmaToolSet<STATE>>({
	agent,
	middleware,
	message,
	trace,
	requestId,
	ctx
}: {
	agent: MagmaAgent<STATE, TOOLS>;
	middleware: MagmaMiddlewareSet<STATE, TOOLS>;
	message: AssistantModelMessage;
	trace: TraceEvent[];
	requestId: string;
	ctx: MagmaCtx;
}): Promise<AssistantModelMessage | null> {
	// get preToolExecution middleware
	const allMiddleware = Object.entries(middleware);
	const preToolExecutionMiddleware = allMiddleware.filter(
		([_, m]) => m.trigger === "preToolExecution"
	);
	if (preToolExecutionMiddleware.length === 0) return message;
	if (typeof message.content === "string") return message;

	const contentToRun = message.content;

	// initialize result content
	const resultContent = [];

	// go through the blocks of the incoming message
	for (let i = 0; i < contentToRun.length; i++) {
		// add the block to the result message
		resultContent.push(contentToRun[i]);
		// if the block is a tool call, we should run each middleware on it
		if (resultContent[i].type === "tool-call") {
			const toolCall = resultContent[i] as ToolCallPart;
			for (const [name, mdlwr] of preToolExecutionMiddleware) {
				try {
					trace.push({
						type: "middleware",
						phase: "start",
						requestId,
						timestamp: Date.now(),
						data: {
							middleware: name,
							input: toolCall.input
						}
					});
					// check if the middleware is supposed to run for this tool call
					if (
						mdlwr.appliesTo !== undefined &&
						!mdlwr.appliesTo.includes(toolCall.toolName)
					) {
						// this middleware should not run on this tool call
						continue;
					}
					// run the middleware on the tool call
					const middlewareResult = (await mdlwr.action(toolCall, {
						state: agent.state
					})) as MagmaToolCall;
					// if the middleware has a return value, we should update the tool call in the result message
					if (middlewareResult !== undefined) {
						agent.log(
							`${name} middleware modified tool call block` +
								"\n" +
								`Original: ${JSON.stringify(toolCall, null, 2)}` +
								"\n" +
								`Modified: ${JSON.stringify(middlewareResult, null, 2)}`
						);
						resultContent[i] = middlewareResult;
					}

					delete ctx.middlewareRetries[name];

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
					const errorMessage = parseErrorToString(error);
					agent.log(`Error in preToolExecution middleware (${name}): ${errorMessage}`);

					ctx.middlewareRetries[name] = (ctx.middlewareRetries[name] ?? 0) + 1;

					trace.push({
						type: "middleware",
						phase: "end",
						status: "error",
						requestId,
						timestamp: Date.now(),
						data: {
							middleware: name,
							error: errorMessage
						}
					});
					if (ctx.middlewareRetries[name] >= agent.maxMiddlewareRetries) {
						if (mdlwr.critical) {
							agent.log(
								`Middleware ${name} failed, and is critical. Returning null...`
							);
							return null;
						} else {
							agent.log(
								`Middleware ${name} failed, but is not critical. Continuing...`
							);
							continue;
						}
					}
					throw new Error(errorMessage);
				}
			}
		}
	}

	// return the result message
	return {
		role: "assistant",
		content: resultContent
	};
}
