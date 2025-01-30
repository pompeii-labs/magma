export type HookRequestLocation = 'Body' | 'Headers' | 'Query';

export type HookRequestPath<T extends HookRequestLocation> = {
    location: T;
    field: string;
};

export function extractPathFromHookRequest(
    request: any,
    path?: HookRequestPath<HookRequestLocation>
): any {
    if (!path) return undefined;

    const { location, field } = path;
    const source = location.toLowerCase();

    // Handle nested paths
    return field.split('.').reduce((obj, key) => obj?.[key], request[source]);
}

// Helper to create type-safe request paths
export const HookRequest = {
    Body: (field: string) => ({ location: 'Body' as const, field }),
    Query: (field: string) => ({ location: 'Query' as const, field }),
    Headers: (field: string) => ({ location: 'Headers' as const, field }),
} as const;

export type MagmaHook = {
    name: string;
    handler: (payload: any) => Promise<void>;
    agentIdPath?: HookRequestPath<HookRequestLocation>;
};
