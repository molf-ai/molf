# Sessions

This page explains how Molf manages sessions — their structure, lifecycle, persistence format, and per-session configuration options.

## Session Model

A session represents a single interaction thread between a user and the AI agent, bound to a specific worker. Each session carries:

- **sessionId** — a UUID that uniquely identifies the session
- **name** — a human-readable display name (defaults to "Session \<date\>")
- **workerId** — the UUID of the worker this session is bound to
- **messages** — the full message history (user, assistant, and tool messages)
- **config** — optional per-session LLM and behavior overrides
- **metadata** — arbitrary key-value data (e.g. `{ client: "telegram", chatId: 123 }`)

Sessions are bound to a worker at creation time. This means tool calls within a session always go to the same worker, and the worker's working directory determines the file system context for the session.

## Session Lifecycle

A session moves through five stages:

1. **Create** — a client calls `session.create` with a worker ID. The server assigns a UUID, sets the initial name, and persists the session to disk.

2. **Active use** — as the user sends prompts and the agent responds, messages accumulate in memory. The session is periodically saved to disk.

3. **Idle eviction** — after 30 minutes with no prompts, the agent cache for this session is evicted from memory. The session file on disk is unaffected.

4. **Release** — when no clients are subscribed and no agent is cached, the session is saved to disk and removed from the in-memory cache.

5. **Resume** — the next `session.load` call reads the session back from disk into memory, and the session continues where it left off.

After a turn completes, the server checks whether the context window usage exceeds 80%. If it does and there are enough messages, the server performs automatic context summarization by injecting summary checkpoint messages into the session history. See [Context Summarization](#context-summarization) below for details.

## Persistence

Sessions are stored as JSON files in the data directory:

```
{dataDir}/
├── server.json              # Auth token hash
└── sessions/
    ├── a1b2c3d4-....json    # One file per session
    ├── e5f6a7b8-....json
    └── ...
```

Each session file contains the complete state needed to resume a session:

```typescript
{
  sessionId: string;                    // UUID
  name: string;                         // Display name
  workerId: string;                     // Bound worker UUID
  createdAt: number;                    // Unix timestamp (ms)
  lastActiveAt: number;                 // Unix timestamp (ms)
  config?: {
    llm?: Partial<LLMConfig>;          // Per-session LLM overrides
    behavior?: Partial<BehaviorConfig>; // Per-session behavior overrides
  };
  metadata?: Record<string, unknown>;   // Arbitrary metadata
  messages: SessionMessage[];           // Full message history
  // Each SessionMessage may also include:
  //   summary?: boolean       — marks summary checkpoint messages
  //   usage?: { inputTokens: number; outputTokens: number }
  //                           — token usage from the LLM response (assistant messages)
}
```

The `SessionManager` keeps active sessions in an in-memory cache and flushes them to disk on save. When a session is released (no listeners, no cached agent), it is written to disk and removed from memory.

## Session Operations

Sessions support five operations, all exposed through the `session.*` tRPC router:

| Operation | What it does |
|-----------|-------------|
| **Create** | Allocates a new session bound to a worker. Accepts an optional name, config overrides, and metadata. |
| **List** | Returns sessions matching optional filters (by name, worker, metadata). Supports pagination with `limit` and `offset`. |
| **Load** | Reads a session from disk (or memory cache) and returns its full message history. This is how clients resume sessions. |
| **Delete** | Removes a session from both memory and disk. |
| **Rename** | Changes a session's display name. |

See [Protocol Reference](/reference/protocol) for the full input/output schemas.

## Per-Session Configuration

When creating a session, you can pass a `config` object to override the server-wide LLM and behavior settings for that session only:

**LLM overrides** (`config.llm`):

| Field | Description |
|-------|-------------|
| `provider` | LLM provider name (`"gemini"` or `"anthropic"`) |
| `model` | Model identifier |
| `temperature` | Sampling temperature |
| `maxTokens` | Maximum tokens in the response |
| `apiKey` | API key (overrides the server's key) |
| `contextWindow` | Context window size in tokens. Controls when automatic summarization triggers (at 80% usage). |

**Behavior overrides** (`config.behavior`):

| Field | Default | Description |
|-------|---------|-------------|
| `systemPrompt` | Molf default | Custom system prompt for this session |
| `maxSteps` | `10` | Maximum tool-use steps per turn |
| `contextPruning` | *(enabled)* | Whether to prune context when approaching the window limit |

This allows different sessions to use different models, temperatures, or even different providers — all within the same server instance.

## Context Summarization

When a session's context grows large, the server automatically summarizes older messages to free up space in the context window. This is transparent to clients — the agent continues working seamlessly with a condensed history.

### How It Works

After each agent turn completes, the server evaluates whether summarization is needed. If the most recent LLM call used 80% or more of the `contextWindow` tokens and there are enough messages in the active window, the server generates a summary of older messages. The summary is injected as a checkpoint pair: a synthetic user boundary message and an assistant summary message, both marked with `summary: true`. Subsequent LLM calls only see messages from the most recent checkpoint forward.

### Trigger Conditions

Summarization runs when **all** of the following are true:

1. There are at least 6 total messages in the session
2. There are at least 6 messages in the active window (since the last summary checkpoint)
3. The latest assistant message's `inputTokens / contextWindow >= 0.8`
4. No summarization is already in progress for this session

### What Gets Preserved

The 4 most recent user turns (and their corresponding responses) are always preserved verbatim. Only older messages are condensed into the summary.

### Summary Format

The generated summary includes structured sections:

- **Goal** — what the user is trying to accomplish
- **Key Instructions** — important directives from the user
- **Progress** — what has been completed so far
- **Key Findings** — important discoveries or results
- **Relevant Files** — files that have been referenced or modified

### Interaction with Context Pruning

Summarization and context pruning are complementary. The context pruner operates on the post-summary window (only messages after the last checkpoint). Additionally, skill tool results are protected from pruning — they are never removed even in aggressive pruning mode.

### The `context_compacted` Event

After successful summarization, the server emits a `context_compacted` event with `summaryMessageId` pointing to the assistant summary message. This event always follows `turn_complete`. See [Protocol Reference](/reference/protocol#agent-events) for the full event schema.

### Error Handling

Summarization failures are logged but never fatal — the agent continues normally if summarization fails.

## See Also

- [Configuration](/guide/configuration) — `contextWindow` and other LLM config fields
- [Server Overview](/server/overview) — how to run the server, auth tokens, LLM providers
- [Protocol Reference](/reference/protocol) — full input/output schemas for all session operations and the `context_compacted` event
- [Architecture](/reference/architecture) — how SessionManager fits into the server's module structure
- [Testing](/reference/testing) — summarization test patterns and LLM mock utilities
