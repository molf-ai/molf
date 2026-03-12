# Event System

The server uses an event-driven architecture to stream agent activity to clients in real time. The EventBus maintains per-session channels, and clients subscribe via the `agent.onEvents` tRPC subscription.

## EventBus

The EventBus is a per-session publish-subscribe system. When the AgentRunner processes a turn, it emits events to the session's channel. All subscribed clients receive these events in real time.

Clients subscribe using the `agent.onEvents({ sessionId })` tRPC subscription.

This is a tRPC subscription that streams `AgentEvent` objects as they occur. On subscription, any pending tool approval requests are replayed so clients can respond to approvals that were requested before they connected.

## Event Types

The system emits 9 event types:

### `status_change`

Fired when the agent's status transitions. The `AgentStatus` values are:

- `idle` -- no active turn
- `streaming` -- LLM is generating a response
- `executing_tool` -- a tool call is being executed by the worker
- `error` -- the turn ended with an error
- `aborted` -- the turn was aborted by the user

### `content_delta`

A chunk of text content from the LLM response. Clients accumulate these deltas to build the full response.

### `tool_call_start`

Emitted when the LLM requests a tool call. Includes the tool name and arguments. This fires before the tool is dispatched to the worker (and before any approval check).

### `tool_call_end`

Emitted when a tool call completes. Includes the tool result.

### `turn_complete`

Fired when the agent finishes a turn. This means the LLM has stopped generating and all tool calls have completed (or the step limit was reached).

### `error`

Emitted when an error occurs during the turn. Includes the error message.

### `tool_approval_required`

Fired when a tool call requires user approval. The client should display the tool name and arguments, then call either `tool.approve` or `tool.deny`.

If approved with `always: true`, the pattern is saved as a runtime always-approve rule for the remainder of the session.

If denied, an optional `feedback` string can be provided to guide the LLM's next attempt.

### `context_compacted`

Emitted when context summarization or pruning occurs, indicating that older messages have been compressed.

### `subagent_event`

A wrapper event containing a child event from a subagent session. The parent session forwards these so clients can track subagent progress. The envelope includes the child session ID and the wrapped event.

## Agent Status Flow

```
idle -> streaming -> executing_tool -> streaming -> ... -> idle
                                                        -> error
                                                        -> aborted
```

The agent alternates between `streaming` (LLM response) and `executing_tool` (tool dispatch) states. A turn ends with the status returning to `idle`, or transitioning to `error` or `aborted`.

## Hooks

The AgentRunner dispatches plugin hooks during the turn lifecycle:

| Hook | Type | Description |
|------|------|-------------|
| `turn_start` | Observing | Fired when a new turn begins |
| `before_prompt` | Modifying | Fired before sending to the LLM; can modify the prompt |
| `after_prompt` | Observing | Fired after the LLM responds |
| `turn_end` | Observing | Fired when the turn completes |

The `before_prompt` hook is the only modifying hook in the turn lifecycle, allowing plugins to alter the prompt before it reaches the LLM. See [Plugins](/reference/plugins) for the full hook reference.

## See Also

- [Sessions](/server/sessions) -- session lifecycle and context management
- [Server Overview](/server/overview) -- EventBus in the startup sequence
- [Protocol](/reference/protocol) -- `agent.onEvents` subscription and event schemas
- [Plugins](/reference/plugins) -- server hooks for extending event behavior
