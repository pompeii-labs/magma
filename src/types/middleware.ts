import { MaybePromise } from "bun";
import { MagmaToolCall, MagmaToolInfo, MagmaToolResult, MagmaToolSet } from "./index";

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

export type MagmaMiddlewareInfo<STATE> = MagmaToolInfo<STATE>;
type MagmaMiddlewareToolKey<TOOLS> = Extract<keyof TOOLS, string>;
type MagmaMiddlewareAppliesTo<TOOL_NAME extends string> = TOOL_NAME | readonly TOOL_NAME[];

export type MagmaMiddleware<
	STATE,
	TOOL_NAME extends string = string,
	TRIGGER extends MagmaMiddlewareTriggerType = MagmaMiddlewareTriggerType
> = {
	trigger: TRIGGER;
	action: (
		message: MagmaMiddlewareParamType<TRIGGER>,
		info: MagmaMiddlewareInfo<STATE>
	) => MaybePromise<MagmaMiddlewareReturnType<TRIGGER>>;
	appliesTo?: TRIGGER extends "preToolExecution"
		? MagmaMiddlewareAppliesTo<TOOL_NAME>
		: TRIGGER extends "onToolExecution"
			? MagmaMiddlewareAppliesTo<TOOL_NAME>
			: never;
	critical?: boolean;
	maxRetries?: number;
	order?: number;
};

export type MagmaMiddlewareVariants<STATE, TOOLS extends Record<string, unknown>> = {
	[TRIGGER in MagmaMiddlewareTriggerType]: MagmaMiddleware<
		STATE,
		MagmaMiddlewareToolKey<TOOLS>,
		TRIGGER
	>;
}[MagmaMiddlewareTriggerType];

export type MagmaMiddlewareSet<
	STATE = Record<string, unknown>,
	TOOLS extends Record<string, unknown> = MagmaToolSet<STATE>
> = Record<string, MagmaMiddleware<STATE, MagmaMiddlewareToolKey<TOOLS>>>;

export const magmaMiddleware = <
	STATE,
	const TOOL_NAME extends string,
	const TRIGGER extends MagmaMiddlewareTriggerType
>(
	middleware: MagmaMiddleware<STATE, TOOL_NAME, TRIGGER>
) => middleware as MagmaMiddleware<STATE, TOOL_NAME, TRIGGER>;

export const magmaMiddlewareSet = <STATE, TOOLS extends MagmaToolSet<STATE> = MagmaToolSet<STATE>>(
	middlewareSet: Record<string, MagmaMiddlewareVariants<STATE, TOOLS>>
) => middlewareSet as MagmaMiddlewareSet<STATE, TOOLS>;
