# Magma Agent Framework

## Agent Behavior

### Main Loop (`main()`)

When `main()` is called with a user message:

1. **preCompletion middleware** runs on the user message
    - If an error is thrown, the error is returned as the assistant message (no LLM call)

2. **LLM completion** is generated

3. **onCompletion middleware** runs on the assistant message
    - If an error is thrown, it triggers a regeneration with the error as context

4. **If there are tool calls:**
    - **preToolExecution middleware** runs on each tool call
        - If an error is thrown, it regenerates the completion with the error as context
    - **Tools are executed**
    - **onToolExecution middleware** runs on each tool result
        - If an error is thrown, the tool output is replaced by that error (for context to LLM)
    - **Main recursively calls itself** until there are no tool calls

5. **onMainFinish middleware** runs only on the final completion (not intermediate tool-calling completions)
    - Functions the same as onCompletion but only runs on the final response

### Trigger Mode

When `main()` is called with a `trigger` parameter:

- Runs a completion forcing a specific tool to be called
- Returns the result of that tool (does not continue the loop)

### Concurrent Execution

- Multiple `main()` calls can run concurrently
- Each `main()` keeps a local messages array so concurrent calls don't interfere
- The agent's messages array is updated in order of promise resolution
- `kill()` stops all concurrent `main()` calls

## Middleware

### Middleware Types

| Trigger            | Runs On                 | Error Behavior                                   | Return Value                     |
| ------------------ | ----------------------- | ------------------------------------------------ | -------------------------------- |
| `preCompletion`    | User message text       | Throws, returns error as response                | void                             |
| `onCompletion`     | Assistant message text  | Throws, triggers regeneration with error context | string (optional, replaces text) |
| `preToolExecution` | Tool calls              | Throws, triggers regeneration with error context | void                             |
| `onToolExecution`  | Tool results            | Replaces tool output with error                  | void                             |
| `onMainFinish`     | Final assistant message | Throws, triggers regeneration with error context | string (optional, replaces text) |

### Retry Logic

- `maxRetries` is configurable per middleware (default: 5)
- Controls how many completion regenerations are allowed for that middleware's errors
- If retries are exhausted:
    - **Non-critical middleware**: Flow continues normally
    - **Critical middleware**: Throws an error, interrupting execution

### `appliesTo` Property

- Available on `preToolExecution` and `onToolExecution` middleware
- Scopes the middleware to only run on specific tools by name

### Execution Order

- Middleware of the same trigger type run in the order defined in the object
- Optional `order` param customizes order (lower numbers execute first)

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

- Called once per LLM completion (not per `main()` call)
- Multiple calls if there are tool-calling loops

### `onError`

- Called only if an error propagates through internal `_main` function
- Example: Critical middleware exhausts retries
- Default implementation rethrows the error

## Tools and Middleware Context

### `MagmaInfo` Object

Both tools and middleware receive a `MagmaInfo` object containing:

- `agent`: The agent instance (and hence its `state`)
- `ctx`: A record for context scoped to the current main loop lifespan

State can be modified directly through `info.agent.state`.
