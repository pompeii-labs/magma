export type TraceEventType = 'completion' | 'middleware' | 'tool_execution';
export type TraceEventPhase = 'start' | 'end';
export type TraceEventStatus = 'abort' | 'error' | 'success';

export type TraceEvent =
    | {
          type: TraceEventType;
          phase: 'start';
          requestId: string;
          timestamp: number;
          data: Record<string, unknown>;
      }
    | {
          type: TraceEventType;
          phase: 'end';
          status: TraceEventStatus;
          requestId: string;
          timestamp: number;
          data: Record<string, unknown>;
      };

export type TraceSpan = {
    type: TraceEventType;
    startEvent: TraceEvent;
    endEvent: TraceEvent;
};
