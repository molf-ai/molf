# Architecture

Molf Assistant uses a **client-server-worker** architecture. A central tRPC WebSocket server coordinates LLM interactions while workers execute tool calls locally. Clients (TUI, Telegram, or custom) connect to the server to chat.

## Three-Tier Model

```
 +-----------+     +-----------+     +-----------+
 | TUI       |     | Telegram  |     | Custom    |
 | Client    |     | Bot       |     | Client    |
 +-----+-----+     +-----+-----+     +-----+-----+
       |                 |                 |
       +--------+--------+--------+--------+
                |  WebSocket/tRPC  |
          +-----v-----------------v-----+
          |                             |
          |          Server             |
          |  (LLM, Sessions, Routing)   |
          |                             |
          +-----+-----+-----------+-----+
                |     |           |
       +--------+     |     +----+-------+
       |              |              |
 +-----v-----+  +----v------+  +---v-------+
 | Worker A   |  | Worker B  |  | Worker C  |
 | (project/) |  | (api/)    |  | (infra/)  |
 +-----------+   +-----------+  +-----------+
```

**Key rule:** Clients never talk to workers directly. All communication flows through the server.

- Multiple clients can connect simultaneously
- Multiple workers can connect simultaneously, each bound to a working directory
- The server is the single point of coordination for LLM calls, session state, and tool dispatch

## Package Dependency Graph

The monorepo has 6 packages under `packages/`:

```
 protocol           (shared types, Zod schemas, tRPC router definition)
    ^       ^       ^       ^
    |       |       |       |
 agent-core |    worker  client-tui  client-telegram
    ^       |
    |       |
  server ---+--- (type-only: AppRouter) ---> client-tui
            |                           ---> client-telegram
            +--- (type-only: AppRouter) ---> worker
```

| Package | Depends On | Description |
|---------|-----------|-------------|
| `protocol` | *(none)* | Shared types, Zod schemas, tRPC router definition, CLI utilities |
| `agent-core` | `protocol` | Agent class, Session, ToolRegistry, LLM providers, system prompts |
| `server` | `agent-core`, `protocol` | WebSocket server, SessionManager, AgentRunner, ToolDispatch, EventBus |
| `worker` | `protocol` | Tool executor, skill loading, server connection, reconnection |
| `client-tui` | `protocol`, `server` (type-only) | Ink/React terminal client |
| `client-telegram` | `protocol`, `server` (type-only) | Telegram bot client using grammY |

## Message Flow

A complete prompt round-trip from client to server to LLM to worker and back:

```
 Client              Server              LLM               Worker
   |                   |                  |                   |
   |  agent.prompt     |                  |                   |
   |  { sessionId,     |                  |                   |
   |    text }         |                  |                   |
   |------------------>|                  |                   |
   |                   |                  |                   |
   |  event:           |  streamText()    |                   |
   |  status_change    |----------------->|                   |
   |  "streaming"      |                  |                   |
   |<------------------|                  |                   |
   |                   |  text-delta      |                   |
   |  event:           |<-----------------|                   |
   |  content_delta    |                  |                   |
   |<------------------|                  |                   |
   |                   |  tool-call       |                   |
   |  event:           |<-----------------|                   |
   |  status_change    |                  |                   |
   |  "executing_tool" |                  |                   |
   |<------------------|                  |                   |
   |                   |                  |                   |
   |  event:           |  ToolDispatch                        |
   |  tool_call_start  |  .dispatch()     |                   |
   |<------------------|--------------------------------------->|
   |                   |                  |     execute tool   |
   |                   |                  |                   |
   |                   |  worker.toolResult                   |
   |  event:           |<---------------------------------------|
   |  tool_call_end    |                  |                   |
   |<------------------|                  |                   |
   |                   |                  |                   |
   |                   |  streamText()    |                   |
   |  event:           |  (with result)   |                   |
   |  status_change    |----------------->|                   |
   |  "streaming"      |                  |                   |
   |<------------------|                  |                   |
   |                   |  finish          |                   |
   |  event:           |<-----------------|                   |
   |  turn_complete    |                  |                   |
   |<------------------|                  |                   |
   |                   |                  |                   |
   |  event:           |                  |                   |
   |  status_change    |                  |                   |
   |  "idle"           |                  |                   |
   |<------------------|                  |                   |
```

1. Client sends `agent.prompt` with session ID and text
2. Server loads the session, builds tools from the worker, and calls `streamText()` on the LLM
3. LLM streams text deltas back; server emits `content_delta` events to subscribed clients
4. If the LLM requests a tool call, server dispatches it to the bound worker via `ToolDispatch`
5. Worker executes the tool and returns the result via `worker.toolResult`
6. Server feeds the result back to the LLM and continues streaming
7. When the LLM finishes (no more tool calls), server emits `turn_complete` with the final message
8. Server checks if context usage ≥80% — if so, runs summarization and emits `context_compacted`
9. The agent loop may repeat steps 3-7 multiple times (up to `maxSteps`, default 10)

## Event System

The server uses an internal **EventBus** for per-session pub/sub:

- **Producers**: `AgentRunner` emits events as the agent executes (status changes, content deltas, tool calls, errors)
- **Consumers**: Client subscriptions via `agent.onEvents` receive events in real-time
- Events are scoped to a session ID — clients only receive events for sessions they subscribe to
- 8 event types: `status_change`, `content_delta`, `tool_call_start`, `tool_call_end`, `turn_complete`, `error`, `tool_approval_required`, `context_compacted`

See [Protocol Reference](/reference/protocol) for the full event type definitions.

## Key Abstractions

### AgentRunner

Orchestrates agent execution on the server side:

- Maintains a cache of `Agent` instances per session (loaded on demand, evicted after 30 min idle)
- On each prompt: loads session, resolves worker, builds remote tools, builds system prompt, runs the agent
- Enforces a 10-minute turn timeout
- Maps internal agent events to `AgentEvent` types and publishes them to the EventBus
- Persists messages to the session after each turn
- Performs automatic context summarization when the context window nears capacity
- Handles tool attachments (images inlined to LLM, other binary passed as file data) and runs server-side tool enhancement hooks

### ToolDispatch

Routes tool calls from the server to workers:

- Built on `WorkerDispatch<TRequest, TResult>`, a generic promise-based dispatch pattern
- When a tool call arrives: creates a promise, queues the request for the target worker
- The worker's `onToolCall` subscription drains the queue and executes the tool
- The worker sends back `toolResult`, which resolves the promise
- Default timeout: 120 seconds
- Worker disconnect immediately rejects all pending dispatches
- Result type: `{ output: string; error?: string; meta?: ToolResultMetadata; attachments?: Attachment[] }`

### SessionManager

In-memory cache with disk persistence for sessions:

- **Load**: checks memory cache first, falls back to reading JSON from disk
- **Save**: writes session state as JSON to `{dataDir}/sessions/{id}.json`
- **Release**: saves to disk and removes from memory cache
- Sessions are cached in memory while active and flushed to disk on save

### ConnectionRegistry

Tracks all connected WebSocket clients:

- Workers: registered with their tools, skills, and metadata (workdir, AGENTS.md content)
- Clients: registered with a client ID and name
- Provides lookups by worker ID, connection-to-worker mapping, and worker listing

## Server Module Table

| Module | File | Responsibility |
|--------|------|----------------|
| main | `src/main.ts` | Entry point: CLI args, config, start server, print auth token, signal handling |
| server | `src/server.ts` | Create WebSocket server, initialize all components, handle connection lifecycle |
| config | `src/config.ts` | Load `molf.yaml`, parse CLI args |
| auth | `src/auth.ts` | Token generation, SHA-256 hashing, verification; stores hash in `server.json` |
| context | `src/context.ts` | `ServerContext` interface, `authedProcedure` middleware |
| router | `src/router.ts` | Complete tRPC router with 4 sub-routers: session, agent, tool, worker |
| session-mgr | `src/session-mgr.ts` | `SessionManager`: in-memory cache + disk persistence |
| event-bus | `src/event-bus.ts` | `EventBus`: per-session pub/sub for agent events |
| agent-runner | `src/agent-runner.ts` | `AgentRunner`: agent instance cache, prompt orchestration, event mapping, automatic context summarization |
| tool-dispatch | `src/tool-dispatch.ts` | `ToolDispatch`: promise-based tool call routing to workers |
| tool-enhancements | `src/tool-enhancements.ts` | Server-side hooks for tool execution (beforeExecute/afterExecute); handles nested instruction injection |
| worker-dispatch | `src/worker-dispatch.ts` | `WorkerDispatch<T, R>`: generic dispatch pattern with queue and timeout |
| upload-dispatch | `src/upload-dispatch.ts` | `UploadDispatch`: file upload routing to workers |
| fs-dispatch | `src/fs-dispatch.ts` | `FsDispatch`: filesystem read routing to workers (for truncated output retrieval) |
| connection-registry | `src/connection-registry.ts` | `ConnectionRegistry`: tracks connected workers and clients |
| inline-media-cache | `src/inline-media-cache.ts` | `InlineMediaCache`: image byte cache for re-inlining (8h TTL, 200MB max) |

## Worker Module Table

| Module | File | Responsibility |
|--------|------|----------------|
| main | `src/main.ts` | Entry point: CLI args, start worker |
| connection | `src/connection.ts` | `WorkerConnection`: WebSocket with reconnection (exponential backoff) |
| identity | `src/identity.ts` | Worker UUID persistence in `{workdir}/.molf/worker.json` |
| tool-executor | `src/tool-executor.ts` | Execute tool calls, path resolution, structured result envelopes (`ToolResultEnvelope`) |
| skills | `src/skills.ts` | Load skills from `{workdir}/skills/{name}/SKILL.md` |
| uploads | `src/uploads.ts` | Handle file uploads to `{workdir}/.molf/uploads/` |
| truncation | `src/truncation.ts` | Truncate large tool output and save full content to `.molf/tool-output/` |
| tools/ | `src/tools/*.ts` | Built-in tool handlers: shell_exec, read_file, write_file, edit_file, glob, grep |

## Identity Model

| Entity | ID Format | Name | Notes |
|--------|----------|------|-------|
| Worker | UUID (persisted in `.molf/worker.json`) | User-provided (`--name`) | Same UUID across restarts enables session rebinding |
| Client | UUID (generated per connection) | User-provided or default | Passed as `clientId` query param |
| Session | UUID (generated on create) | Auto-generated or user-provided | Bound to a worker at creation time |

## See Also

- [Server Overview](/server/overview) — running the server, auth tokens, LLM providers
- [Worker Overview](/worker/overview) — running a worker, identity, reconnection
- [Sessions](/server/sessions) — session lifecycle and persistence
- [Protocol Reference](/reference/protocol) — full tRPC API with all procedures and event types
