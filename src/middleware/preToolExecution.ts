import { AssistantModelMessage, ToolCallPart } from "ai";
import { MagmaInfo, MagmaMiddlewareSet, MagmaToolSet, TraceEvent } from "../types";
import { DEFAULT_MAX_MIDDLEWARE_RETRIES } from "../agent";
import { parseErrorToString } from "../helpers";

export async function runPreToolExecutionMiddleware<STATE, TOOLS extends MagmaToolSet<STATE>>({
	info,
	middleware,
	message,
	trace,
	requestId,
	middlewareRetries
}: {
	info: MagmaInfo<STATE, TOOLS>;
	middleware: MagmaMiddlewareSet<STATE, TOOLS>;
	message: AssistantModelMessage;
	trace: TraceEvent[];
	requestId: string;
	middlewareRetries: Record<string, number>;
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
					await mdlwr.action(toolCall, info);

					delete middlewareRetries[name];

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
					const errorMessage = parseErrorToString(error);
					info.agent.log(
						`Error in preToolExecution middleware (${name}): ${errorMessage}`
					);

					middlewareRetries[name] = (middlewareRetries[name] ?? 0) + 1;

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
					if (
						middlewareRetries[name] >=
						(mdlwr.maxRetries ?? DEFAULT_MAX_MIDDLEWARE_RETRIES)
					) {
						if (mdlwr.critical) {
							info.agent.log(
								`Middleware ${name} failed, and is critical. Returning null...`
							);
							return null;
						} else {
							info.agent.log(
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
