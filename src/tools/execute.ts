import { AssistantModelMessage, ToolModelMessage, ToolResultPart } from "ai";
import { MagmaInfo, MagmaToolSet, TraceEvent } from "../types";
import { parseErrorToString } from "../helpers";
import { MagmaAgent } from "../agent";

/**
 * Given a tool call, find the appropriate function to handle the run
 *
 * @param tools the list of tools available to execute
 * @param message AssistantModelMessage to execute tools on
 * @param trace trace event array
 * @param requestId request id
 * @param send the send function to be passed to the tools
 * @param state the agent state to be passed to the tools
 * @returns MagmaUserMessage with tool results
 */
export async function executeTools<STATE, TOOLS extends MagmaToolSet<STATE>>({
	info,
	message,
	trace,
	requestId
}: {
	info: MagmaInfo<STATE, TOOLS>;
	message: AssistantModelMessage;
	trace: TraceEvent[];
	requestId: string;
	state: STATE;
}): Promise<ToolModelMessage> {
	const toolResultMessage: ToolModelMessage = {
		role: "tool",
		content: []
	};

	// execute the tool calls
	for (const contentPart of message.content) {
		if (typeof contentPart === "string") continue;
		if (contentPart.type !== "tool-call") continue;
		if (contentPart.providerExecuted) continue;

		const toolCall = contentPart;

		let toolResult: ToolResultPart;

		try {
			const tool = info.agent.tools[toolCall.toolName];
			if (!tool) throw new Error(`No tool found to handle call for ${toolCall.toolName}()`);

			// Trace individual tool call execution
			trace.push({
				type: "tool_execution",
				phase: "start",
				requestId,
				timestamp: Date.now(),
				data: {
					toolCall,
					toolName: toolCall.toolName
				}
			});

			let result = await tool.execute?.(toolCall.input, {
				toolCallId: toolCall.toolCallId,
				messages: [],
				agent: info.agent as unknown as MagmaAgent<STATE, MagmaToolSet<STATE>>,
				ctx: info.ctx
			});

			if (!result) {
				info.agent.log(`No result returned for ${toolCall.toolName}()`);
				result = {
					type: "text",
					value: "No result returned"
				};
			}

			if (typeof result === "string") {
				result = {
					type: "text",
					value: result
				};
			} else if (typeof result === "object") {
				const typeOptions: ToolResultPart["output"]["type"][] = [
					"text",
					"content",
					"json",
					"error-text",
					"error-json"
				];
				if (!("type" in result) || !typeOptions.includes(result["type"])) {
					result = {
						type: "json",
						value: result
					};
				}
			}

			toolResult = {
				type: "tool-result",
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				providerOptions: toolCall.providerOptions,
				output: result as ToolResultPart["output"]
			};

			trace.push({
				type: "tool_execution",
				phase: "end",
				status: "success",
				requestId,
				timestamp: Date.now(),
				data: {
					toolCall,
					toolName: toolCall.toolName,
					result: toolResult
				}
			});
		} catch (error) {
			const errorString = parseErrorToString(error);
			const errorMessage = `Tool Execution Failed for ${toolCall.toolName}() - ${errorString}`;
			info.agent.log(errorMessage);

			trace.push({
				type: "tool_execution",
				phase: "end",
				status: "error",
				requestId,
				timestamp: Date.now(),
				data: {
					toolCall,
					toolName: toolCall.toolName,
					error: errorString
				}
			});

			toolResult = {
				type: "tool-result",
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				providerOptions: toolCall.providerOptions,
				output: { type: "error-text", value: errorString }
			};
		}

		toolResultMessage.content.push(toolResult);
	}

	return toolResultMessage;
}
