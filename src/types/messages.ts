import { MagmaProvider } from './providers';

export type MagmaCompletionStopReason =
    | 'natural'
    | 'tool_call'
    | 'content_filter'
    | 'max_tokens'
    | 'unsupported'
    | 'unknown';

export type MagmaCompletion = {
    message: MagmaMessage;
    provider: MagmaProvider;
    model: string;
    usage: MagmaUsage;
    stop_reason: MagmaCompletionStopReason;
};

export type MagmaUsage = {
    input_tokens: number;
    output_tokens: number;
    cache_write_tokens: number;
    cache_read_tokens: number;
};

export type MagmaImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/url';

export type MagmaImage = {
    data: string;
    type: MagmaImageType;
};

// Provider-agnostic message type
export type MagmaMessageType =
    | MagmaSystemMessageType
    | MagmaAssistantMessageType
    | MagmaUserMessageType;

export type MagmaSystemMessageType = {
    id?: string | number;
    role: 'system';
    blocks?: MagmaContentBlock[];
    content?: string;
    cache?: boolean;
};

export type MagmaTextBlock = {
    type: 'text';
    text: string;
};

export type MagmaToolCallBlock = {
    type: 'tool_call';
    tool_call: MagmaToolCall;
};

export type MagmaToolResultBlock = {
    type: 'tool_result';
    tool_result: MagmaToolResult;
};

export type MagmaReasoningBlock = {
    type: 'reasoning';
    reasoning: string;
    redacted?: true;
    signature?: string;
};

export type MagmaImageBlock = {
    type: 'image';
    image: MagmaImage;
};

export type MagmaContentBlock = (
    | MagmaTextBlock
    | MagmaToolCallBlock
    | MagmaToolResultBlock
    | MagmaReasoningBlock
    | MagmaImageBlock
) & {
    cache?: boolean;
};

type MagmaUserMessageType = {
    id?: string | number;
    role: 'user';
    blocks?: MagmaContentBlock[];
    content?: string;
};

type MagmaAssistantMessageType = {
    id?: string | number;
    role: 'assistant';
    blocks?: MagmaContentBlock[];
    content?: string;
};

// Provider-agnostic tool/function type
export type MagmaToolCall = {
    id: string;
    fn_name: string;
    fn_args: Record<string, any>;
    error?: string;
};

export type MagmaToolResult = {
    id: string;
    result: string | Record<string, any>;
    error?: boolean;
    fn_name: string;
};

export type MagmaStreamChunk = {
    id: string;
    provider: MagmaProvider;
    model: string;
    delta: MagmaAssistantMessage;
    buffer: MagmaAssistantMessage;
    stop_reason: MagmaCompletionStopReason;
    usage: {
        input_tokens: number | null;
        output_tokens: number | null;
        cache_write_tokens: number | null;
        cache_read_tokens: number | null;
    };
};

export class MagmaMessage {
    id?: string | number;
    role: MagmaMessageType['role'];
    blocks: MagmaContentBlock[];

    constructor({ role, content, blocks, id }: MagmaMessageType) {
        this.id = id;
        this.role = role;
        if (content && blocks) {
            throw new Error('Cannot provide both content and blocks to MagmaMessage constructor');
        }

        if (content) {
            this.blocks = [
                {
                    type: 'text',
                    text: content,
                },
            ];
        } else if (blocks) {
            this.blocks = blocks;
        }
    }

    public getText(): string {
        return this.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    }

    public getToolCalls(): MagmaToolCall[] {
        return this.blocks
            .filter((block) => block.type === 'tool_call')
            .map((block) => block.tool_call);
    }

    public getToolResults(): MagmaToolResult[] {
        return this.blocks
            .filter((block) => block.type === 'tool_result')
            .map((block) => block.tool_result);
    }

    public getReasoning(): string {
        return this.blocks
            .filter((block) => block.type === 'reasoning' && !block.redacted)
            .map((block: MagmaReasoningBlock) => block.reasoning)
            .join('\n');
    }

    public getImages(): MagmaImage[] {
        return this.blocks.filter((block) => block.type === 'image').map((block) => block.image);
    }

    public get content(): string {
        return this.getText();
    }
}

export class MagmaUserMessage extends MagmaMessage {
    role: 'user' = 'user';
    constructor(magmaUserMessage: MagmaUserMessageType) {
        super(magmaUserMessage);
    }
}

export class MagmaAssistantMessage extends MagmaMessage {
    role: 'assistant' = 'assistant';
    constructor(magmaAssistantMessage: MagmaAssistantMessageType) {
        super(magmaAssistantMessage);
    }
}

export class MagmaSystemMessage extends MagmaMessage {
    role: 'system' = 'system';
    constructor(magmaSystemMessage: MagmaSystemMessageType) {
        super(magmaSystemMessage);
        this.blocks.forEach((block) => {
            block.cache = magmaSystemMessage.cache;
        });
    }
}
