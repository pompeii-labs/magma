# Magma Agent Framework

## Agent Behavior

### Run Loop (`run()`)

When `run()` is called with user-message content:

1. **preCompletion middleware** runs on the user message
    - If an error is thrown, the error is emitted as an assistant message through `onMessage`
    - No LLM call is made, and that `run()` promise resolves

2. **LLM completion** is generated

3. **onCompletion middleware** runs on the assistant message
    - If an error is thrown, it triggers a regeneration with the error as context

4. **If there are tool calls:**
    - **preToolExecution middleware** runs on each tool call
        - If an error is thrown, it regenerates the completion with the error as context
    - **Tools are executed**
    - **onToolExecution middleware** runs on each tool result
        - If an error is thrown, the tool output is replaced by that error (for context to LLM)
    - The processing loop continues until there are no tool calls

### Steering

- Only one processing loop runs at a time
- Calling `run()` while processing queues a steering message
- Queued messages are inserted FIFO after a tool result or terminal completion
- Each `run()` promise resolves after its message contributes to a terminal completion
- Assistant and tool-result messages are delivered through `onMessage`
- `kill()` aborts the active turn and rejects active and queued calls
- Cancellation rolls history back to the last terminal response or completed tool result

## Middleware

### Middleware Types

| Trigger            | Runs On                | Error Behavior                                   | Return Value                     |
| ------------------ | ---------------------- | ------------------------------------------------ | -------------------------------- |
| `preCompletion`    | User message text      | Emits error as an assistant message              | void                             |
| `onCompletion`     | Assistant message text | Throws, triggers regeneration with error context | string (optional, replaces text) |
| `preToolExecution` | Tool calls             | Throws, triggers regeneration with error context | void                             |
| `onToolExecution`  | Tool results           | Replaces tool output with error                  | void                             |

### Retry Logic

- `maxRetries` is honored by `onCompletion` and `preToolExecution` middleware (default: 5)
- It is the failure threshold; failures below the threshold regenerate the completion with the error as context
- At the threshold:
    - **Non-critical middleware**: The flow continues with the current completion
    - **Critical middleware**: The turn is aborted and its affected `run()` promises reject
- `preCompletion` errors are emitted immediately without retrying
- `onToolExecution` errors replace the corresponding tool output without retrying

### `appliesTo` Property

- Available on `preToolExecution` and `onToolExecution` middleware
- Scopes the middleware to only run on specific tools by name

### Execution Order

- Middleware of the same trigger type run in the order defined in the object
- The optional `order` property is currently not applied

## Agent Configuration

### `messageContext`

- Controls the slice of messages sent to the LLM
- Value of `20` = 20 most recent messages
- Value of `-1` = full messages array (default)

### `getSystemPrompts`

- Called every time a completion is generated
- System prompts are NOT stored in message history
- NOT affected by `messageContext`

### `onUsageUpdate`

- Called once after each successfully completed LLM completion (not per `run()` call)
- Multiple calls if there are tool-calling loops
- Not called for aborted or failed completion attempts

### `onError`

- Called when a non-abort error escapes processing a turn
- Examples include LLM failures, callback failures, and critical middleware exhausting retries
- Not called for cancellation or handled `preCompletion` errors
- Affected `run()` promises reject with the propagated error
- Errors thrown by `onError` itself are ignored; the default handler logs to `console.error`

## Tools and Middleware Context

### `MagmaInfo` Object

Both tools and middleware receive a `MagmaInfo` object containing:

- `agent`: The agent instance (and hence its `state`)
- `ctx`: A record scoped to the current processing turn; steering incorporated into that turn shares it

State can be modified directly through `info.agent.state`.
