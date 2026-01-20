import { MagmaAgent } from "../../agent";

export interface MagmaJob<STATE> {
	handler: (agent: MagmaAgent<STATE, {}>) => Promise<void> | void;
	schedule: string;
	options?: { timezone?: string };
	name?: string;
}
