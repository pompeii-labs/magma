import { MaybePromise } from "bun";
import { MagmaInfo, MagmaToolCall, MagmaToolResult, MagmaToolSet } from "./index";

export const MagmaMiddlewareTriggers = [
	"onCompletion",
	"preCompletion",
	"onToolExecution",
	"preToolExecution",
	"onMainFinish"
] as const;

export type MagmaMiddlewareTriggerType = (typeof MagmaMiddlewareTriggers)[number];

export type MagmaMiddlewareParamType<TRIGGER extends MagmaMiddlewareTriggerType> =
	TRIGGER extends "preToolExecution"
		? MagmaToolCall
		: TRIGGER extends "onToolExecution"
			? MagmaToolResult
			: TRIGGER extends "preCompletion"
				? string
				: TRIGGER extends "onCompletion"
					? string
					: TRIGGER extends "onMainFinish"
						? string
						: never;

export type MagmaMiddlewareReturnType<TRIGGER extends MagmaMiddlewareTriggerType> =
	TRIGGER extends "preCompletion"
		? void
		: TRIGGER extends "onCompletion"
			? string | void
			: TRIGGER extends "preToolExecution"
				? void
				: TRIGGER extends "onToolExecution"
					? void
					: TRIGGER extends "onMainFinish"
						? string | void
						: never;

export type MagmaMiddleware<
	STATE,
	TOOLS extends MagmaToolSet<STATE>,
	TRIGGER extends MagmaMiddlewareTriggerType = MagmaMiddlewareTriggerType
> = {
	trigger: TRIGGER;
	action: (
		message: MagmaMiddlewareParamType<TRIGGER>,
		info: MagmaInfo<STATE, TOOLS>
	) => MaybePromise<MagmaMiddlewareReturnType<TRIGGER>>;
	appliesTo?: TRIGGER extends "preToolExecution"
		? (keyof TOOLS)[]
		: TRIGGER extends "onToolExecution"
			? (keyof TOOLS)[]
			: never;
	critical?: boolean;
	maxRetries?: number;
	order?: number;
};

export type MagmaMiddlewareSet<
	STATE = Record<string, unknown>,
	TOOLS extends MagmaToolSet<STATE> = MagmaToolSet<STATE>
> = Record<string, MagmaMiddleware<STATE, TOOLS>>;

export const magmaMiddleware = <
	STATE,
	TOOLS extends MagmaToolSet<STATE>,
	TRIGGER extends MagmaMiddlewareTriggerType
>(
	tool: MagmaMiddleware<STATE, TOOLS, TRIGGER>
) => tool as MagmaMiddleware<STATE, TOOLS, TRIGGER>;
