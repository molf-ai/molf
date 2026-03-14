# Sessions

Sessions track the message history between the user and the agent. Each session contains an ordered list of messages with metadata for tool calls, file attachments, and token usage.

## Session Lifecycle

Sessions are created via the `session.create` oRPC procedure, which requires a `workerId` and `workspaceId`. Each session receives a unique UUID.

The SessionManager maintains an in-memory cache backed by disk persistence. Sessions are written to disk atomically using a temporary file and rename to prevent corruption.

Sessions can be listed (with pagination, 1-200 per page), loaded, renamed, and deleted through the `session.*` procedures.

### Hooks

Plugin hooks fire during session operations:

- `session_create` -- after a new session is created
- `session_delete` -- after a session is deleted
- `session_save` -- after a session is persisted to disk

## Session Data

Each `SessionMessage` can include:

- **Text content** -- the user prompt or assistant response
- **File references** (`FileRef[]`) -- attached files (up to 10 per prompt)
- **Tool calls** -- records of tool invocations and their results
- **Usage** -- token counts (`inputTokens`, `outputTokens`) for the message
- **Model** -- which LLM model generated the response
- **Synthetic flag** -- marks system-generated messages
- **Summary flag** -- marks messages created by the summarization process

## Persistence

Sessions are stored as JSON files at `{dataDir}/sessions/{id}.json`. The SessionManager keeps active sessions in an in-memory cache and flushes to disk on save. When a session is released (no listeners, no cached agent), it is written to disk and removed from memory.

Writes are atomic: the manager writes to a temporary file first, then renames it to the target path.

## Agent Runner

The AgentRunner manages the LLM interaction for each session. It caches `Agent` instances per session and evicts them after 30 minutes of inactivity.

### Prompt Flow

When a prompt arrives via `agent.prompt`:

1. Validate the session exists and the worker is connected
2. Resolve the model -- priority: prompt-level model > workspace config > server default
3. Prepare or retrieve the cached Agent instance
4. Persist the user message to the session
5. Run the agent asynchronously (fire-and-forget to the caller)

### System Prompt

The system prompt is assembled from multiple sources:

- Default agent instructions
- Skill hints (available skills the LLM can request)
- Task/subagent hints (if agents are available)
- Worker's working directory context
- Media context (if inline images are present)
- Runtime context (current time, timezone)

### Step Limits

Each agent turn runs up to `maxSteps` steps (default: 10). Each step may produce text, tool calls, or both.

### Doom Loop Detection

If the agent makes 3 identical consecutive tool calls, a warning message is injected into the session to break the loop.

## Context Summarization

When the session approaches the model's context window limit, the server automatically summarizes older messages to free up space.

| Parameter | Value |
|-----------|-------|
| Trigger threshold | 80% of context window used |
| Minimum messages | 6 before summarization activates |
| Preserved turns | Last 4 turns kept intact |
| Max summary tokens | 4,096 |
| Summary temperature | 0.3 |

After each turn, the server checks whether summarization is needed. If triggered, it generates a summary of older messages and injects a checkpoint pair: a synthetic user boundary message and an assistant summary (both marked with `summary: true`). Subsequent LLM calls only see messages from the most recent checkpoint forward.

A `context_compacted` event is emitted after successful summarization. Summarization failures are logged but never fatal.

## Context Pruning

When individual tool results consume too much context, the pruner trims them in two passes.

### Soft Trim (first pass)

- Activates when context exceeds 30% of the limit
- Keeps the first and last 1,500 characters of large tool results
- Replaces the middle with a truncation notice

### Hard Clear (second pass)

- Activates when context exceeds 50% of the limit
- Removes tool result content entirely, replacing with a notice

### Rules

- Only tool results with 50,000+ characters are eligible for pruning
- The last 3 assistant messages are never pruned
- Skill tool results are excluded from pruning
- On context length errors from the LLM, aggressive mode reruns pruning with lower thresholds

## See Also

- [Event System](/server/events) -- events emitted during agent turns
- [LLM Providers](/server/llm-providers) -- model resolution and provider configuration
- [Protocol](/reference/protocol) -- session and agent oRPC procedures
- [Subagents](/server/subagents) -- child session creation during subagent execution
