import { TextPart, UserModelMessage } from "ai";
import { MagmaInfo, MagmaMiddlewareSet, MagmaToolSet, TraceEvent } from "../types";
import { parseErrorToString } from "../helpers";

export async function runPreCompletionMiddleware<STATE, TOOLS extends MagmaToolSet<STATE>>({
	info,
	middleware,
	message,
	trace,
	requestId
}: {
	info: MagmaInfo<STATE, TOOLS>;
	middleware: MagmaMiddlewareSet<STATE, TOOLS>;
	message: UserModelMessage;
	trace: TraceEvent[];
	requestId: string;
}): Promise<UserModelMessage> {
	// get preCompletion middleware
	const allMiddleware = Object.entries(middleware);
	const preCompletionMiddleware = allMiddleware.filter(([_, m]) => m.trigger === "preCompletion");
	if (preCompletionMiddleware.length === 0) return message;

	const contentToRun =
		typeof message.content === "string"
			? [{ type: "text", text: message.content } as TextPart]
			: message.content;

	// initialize result content
	const resultContent = [];

	// go through the blocks of the incoming message
	for (let i = 0; i < contentToRun.length; i++) {
		// add the block to the result message
		resultContent.push(contentToRun[i]);
		// if the block is a text block, we should run each middleware on it
		if (contentToRun[i].type === "text") {
			const textBlock = contentToRun[i] as TextPart;
			for (const [name, mdlwr] of preCompletionMiddleware) {
				try {
					trace.push({
						type: "middleware",
						phase: "start",
						requestId,
						timestamp: Date.now(),
						data: {
							middleware: name,
							input: textBlock.text
						}
					});
					// run the middleware on the text block
					await mdlwr.action(textBlock.text, info);

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
					info.agent.log(`Error in preCompletion middleware (${name}): ${errorMessage}`);

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
					throw new Error(errorMessage);
				}
			}
		}
	}

	// return the result message
	return {
		role: "user",
		content: resultContent
	};
}
