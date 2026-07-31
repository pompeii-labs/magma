import { LanguageModelUsage } from "ai";
import { MagmaToolSet } from "./tools";
import { MagmaAgent } from "../agent";
import { MagmaAssistantMessage, MagmaToolResultMessage } from "./messages";
import { MaybePromise } from "bun";

export * from "./messages";
export * from "./tools";
export * from "./middleware";
export * from "./trace";

export type MagmaInfo<STATE, TOOLS extends MagmaToolSet<STATE>> = {
	agent: MagmaAgent<STATE, TOOLS>;
	ctx: Record<string, unknown>;
};

export type MagmaMessageHandler<STATE, TOOLS extends MagmaToolSet<STATE> = MagmaToolSet<STATE>> = (
	message: MagmaAssistantMessage | MagmaToolResultMessage,
	info: MagmaInfo<STATE, TOOLS>
) => MaybePromise<void>;

export type MagmaUsage = LanguageModelUsage;
