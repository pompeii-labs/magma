import { MagmaAssistantMessage, MagmaMessage } from "../types";

export function mapNumberInRange(
	n: number,
	min: number,
	max: number,
	newMin: number,
	newMax: number
): number {
	return ((n - min) * (newMax - newMin)) / (max - min) + newMin;
}

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseErrorToString(error: unknown): string {
	return parseErrorToError(error).message;
}

export function parseErrorToError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	} else if (typeof error === "string") {
		return new Error(error);
	} else {
		return new Error(JSON.stringify(error));
	}
}

export function getMessageText(message: MagmaMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	} else {
		return message.content
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("\n");
	}
}

export function getMessageReasoning(message: MagmaAssistantMessage): string {
	if (typeof message.content === "string") {
		return "";
	} else {
		return message.content
			.filter((p) => p.type === "reasoning")
			.map((p) => p.text)
			.join("\n");
	}
}

export * from "./trace";
