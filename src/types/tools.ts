/* eslint-disable @typescript-eslint/no-explicit-any */

import { Tool, ToolExecutionOptions } from "ai";
import { MagmaInfo } from ".";

export type MagmaToolCallOptions<STATE> = ToolExecutionOptions &
	MagmaInfo<STATE, MagmaToolSet<STATE>>;
type MagmaToolExecuteFunction<STATE, INPUT, OUTPUT> = (
	input: INPUT,
	options: MagmaToolCallOptions<STATE>
) => AsyncIterable<OUTPUT> | PromiseLike<OUTPUT> | OUTPUT;
export type MagmaTool<STATE, INPUT, OUTPUT = any> = Omit<Tool<INPUT, OUTPUT>, "execute"> & {
	execute: MagmaToolExecuteFunction<STATE, INPUT, OUTPUT>;
	enabled?: (info: MagmaInfo<STATE, MagmaToolSet<STATE>>) => boolean;
};

export type MagmaToolSet<STATE> = Record<
	string,
	| Tool<any, any>
	| ((
			| MagmaTool<STATE, never, never>
			| MagmaTool<STATE, any, any>
			| MagmaTool<STATE, any, never>
			| MagmaTool<STATE, never, any>
	  ) &
			Pick<MagmaTool<STATE, any, any>, "execute">)
>;

export const magmaTool = <STATE, INPUT>(tool: MagmaTool<STATE, INPUT>) =>
	tool as MagmaTool<STATE, INPUT>;

export const magmaToolSet = <STATE>(toolSet: MagmaToolSet<STATE>) => toolSet as MagmaToolSet<STATE>;
