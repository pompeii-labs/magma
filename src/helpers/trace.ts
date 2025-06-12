import { TraceEvent, TraceEventType, TraceSpan } from '../types';

export class TraceAnalyzer {
    constructor(private trace: TraceEvent[]) {}

    /**
     * Convert trace events into spans by matching start/end event pairs
     */
    private createSpans(eventType: TraceEventType): TraceSpan[] {
        const spans: TraceSpan[] = [];
        const startEvents = new Map<string, TraceEvent>();

        for (const event of this.trace) {
            if (event.type !== eventType) continue;

            const key = `${event.requestId}-${event.type}`;

            if (event.phase === 'start') {
                startEvents.set(key, event);
            } else if (event.phase === 'end') {
                const startEvent = startEvents.get(key);
                if (startEvent && startEvent.phase === 'start') {
                    const span: TraceSpan = {
                        type: eventType,
                        startEvent,
                        endEvent: event,
                    };
                    spans.push(span);
                    startEvents.delete(key);
                }
            }
        }

        return spans;
    }

    /**
     * Get all middleware executions with their execution times and statuses
     */
    getMiddlewareExecutions(): Array<{
        name: string;
        duration: number;
        status: string;
        requestId: string;
        startTime: number;
        endTime: number;
        payload?: any;
        result?: any;
        error?: string;
    }> {
        const middlewareSpans = this.createSpans('middleware');

        return middlewareSpans.map((span) => ({
            name: span.startEvent.data.middleware as string,
            duration: span.endEvent.timestamp - span.startEvent.timestamp,
            status: span.endEvent.data.status as string,
            requestId: this.getRequestIdFromSpan(span),
            startTime: span.startEvent.timestamp,
            endTime: span.endEvent.timestamp,
            payload: span.startEvent.data.middlewarePayload,
            result: span.endEvent.data.middlewareResult,
            error: span.endEvent.data.error as string,
        }));
    }

    /**
     * Get all tool executions with their execution times and statuses
     */
    getToolExecutions(): Array<{
        toolName: string;
        duration: number;
        status: string;
        requestId: string;
        startTime: number;
        endTime: number;
        args?: any;
        result?: any;
        error?: string;
        toolCallId: string;
    }> {
        const toolSpans = this.createSpans('tool_execution');

        return toolSpans.map((span) => ({
            toolName: span.startEvent.data.toolName as string,
            duration: span.endEvent.timestamp - span.startEvent.timestamp,
            status: span.endEvent.data.status as string,
            requestId: this.getRequestIdFromSpan(span),
            startTime: span.startEvent.timestamp,
            endTime: span.endEvent.timestamp,
            args: span.startEvent.data.args,
            result: span.endEvent.data.result,
            error: span.endEvent.data.error as string,
            toolCallId: span.startEvent.data.toolCallId as string,
        }));
    }

    /**
     * Helper method to extract request ID from span data
     */
    private getRequestIdFromSpan(span: TraceSpan): string {
        return span.startEvent.requestId;
    }

    /**
     * Get all events for a specific request ID
     */
    getEventsByRequestId(requestId: string): TraceEvent[] {
        return this.trace.filter((event) => event.requestId === requestId);
    }

    /**
     * Get the chronological flow of events
     */
    getEventFlow(): Array<{
        timestamp: number;
        type: TraceEventType;
        phase: 'start' | 'end';
        requestId: string;
        details: string;
    }> {
        return this.trace
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((event) => ({
                timestamp: event.timestamp,
                type: event.type,
                phase: event.phase,
                requestId: event.requestId,
                details: this.getEventDetails(event),
            }));
    }

    /**
     * Helper to get human-readable details for an event
     */
    private getEventDetails(event: TraceEvent): string {
        switch (event.type) {
            case 'completion':
                return event.phase === 'start'
                    ? 'Completion started'
                    : `Completion ended with status: ${event.status}`;
            case 'tool_execution':
                const toolName =
                    (event.data as any).toolName || (event.data as any).toolCall?.fn_name;
                return event.phase === 'start'
                    ? `Tool execution started: ${toolName}`
                    : `Tool execution ended: ${toolName} (${event.status})`;
            case 'middleware':
                const middlewareName = (event.data as any).middleware;
                return event.phase === 'start'
                    ? `Middleware started: ${middlewareName}`
                    : `Middleware ended: ${middlewareName} (${event.status})`;
            default:
                return `${event.type} ${event.phase}`;
        }
    }
}
