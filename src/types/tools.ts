/* eslint-disable @typescript-eslint/no-explicit-any */

import { Tool, ToolExecutionOptions } from "ai";
import { MagmaAgent } from "../agent";

export type MagmaToolCallOptions<STATE> = ToolExecutionOptions & MagmaToolInfo<STATE>;
export type MagmaToolInfo<STATE> = {
	agent: MagmaAgent<STATE>;
	ctx: Record<string, unknown>;
};
type MagmaToolExecuteFunction<STATE, INPUT, OUTPUT> = (
	input: INPUT,
	options: MagmaToolCallOptions<STATE>
) => AsyncIterable<OUTPUT> | PromiseLike<OUTPUT> | OUTPUT;
export type MagmaTool<STATE, INPUT, OUTPUT = any> = Omit<Tool<INPUT, OUTPUT>, "execute"> & {
	execute: MagmaToolExecuteFunction<STATE, INPUT, OUTPUT>;
	enabled?: (info: MagmaToolInfo<STATE>) => boolean;
};

type MagmaToolVariants<STATE> =
	| MagmaTool<STATE, never, never>
	| MagmaTool<STATE, any, any>
	| MagmaTool<STATE, any, never>
	| MagmaTool<STATE, never, any>;

type ExecutableMagmaTool<STATE> = MagmaToolVariants<STATE> &
	Pick<MagmaTool<STATE, any, any>, "execute">;

export type MagmaToolSet<STATE> = Record<string, Tool<any, any> | ExecutableMagmaTool<STATE>>;

export const magmaTool = <STATE, INPUT>(tool: MagmaTool<STATE, INPUT>) =>
	tool as MagmaTool<STATE, INPUT>;

export const magmaToolSet = <STATE>(toolSet: MagmaToolSet<STATE>) => toolSet as MagmaToolSet<STATE>;
