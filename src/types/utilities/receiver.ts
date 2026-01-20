import { DecoratedExtras } from ".";

export type MagmaReceiver<STATE> = {
	handler: (
		wsMessage: string,
		extras: Omit<DecoratedExtras<STATE>, "ctx">
	) => Promise<void> | void;
	shouldHandle: (data: string) => boolean;
};
