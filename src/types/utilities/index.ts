import { LanguageModelUsage } from "ai";
import { MagmaAgent } from "../../agent";

export * from "./jobs";
export * from "./middleware";
export * from "./tools";
export * from "./receiver";

export type DecoratedExtras<STATE> = {
	agent: MagmaAgent<STATE, {}>;
	ctx: Record<string, unknown>;
};

export type MagmaUsage = LanguageModelUsage;
