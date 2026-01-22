import { LanguageModelUsage } from "ai";
import { MagmaToolSet } from "./tools";
import { MagmaAgent } from "../agent";

export * from "./messages";
export * from "./tools";
export * from "./middleware";
export * from "./trace";

export type MagmaInfo<STATE, TOOLS extends MagmaToolSet<STATE>> = {
	agent: MagmaAgent<STATE, TOOLS>;
	ctx: Record<string, unknown>;
};

export type MagmaUsage = LanguageModelUsage;
