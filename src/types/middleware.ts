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

export type MagmaMiddleware<
	STATE,
	TOOLS extends MagmaToolSet<STATE>,
	TRIGGER extends MagmaMiddlewareTriggerType = MagmaMiddlewareTriggerType
> = {
	trigger: TRIGGER;
	action: (
		message: MagmaMiddlewareParamType<TRIGGER>,
		info: MagmaInfo<STATE, TOOLS>
	) => MaybePromise<void>;
	appliesTo?: TRIGGER extends "preToolExecution"
		? (keyof TOOLS)[]
		: TRIGGER extends "onToolExecution"
			? (keyof TOOLS)[]
			: never;
	critical?: boolean;
	maxRetries?: number;
	order?: number;
};

export type MagmaMiddlewareSet<STATE, TOOLS extends MagmaToolSet<STATE>> = Record<
	string,
	MagmaMiddleware<STATE, TOOLS>
>;

export const magmaMiddleware = <
	STATE,
	TOOLS extends MagmaToolSet<STATE>,
	TRIGGER extends MagmaMiddlewareTriggerType
>(
	tool: MagmaMiddleware<STATE, TOOLS, TRIGGER>
) => tool as MagmaMiddleware<STATE, TOOLS, TRIGGER>;
