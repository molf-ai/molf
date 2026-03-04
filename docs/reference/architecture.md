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
| `agent-core` | `protocol` | Agent class, Session, ToolRegistry, provider system (catalog, registry, SDK, transforms), system prompts |
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
   |                   |  ApprovalGate    |                   |
   |                   |  .evaluate()     |                   |
   |                   |  → allow/deny/   |                   |
   |                   |    ask           |                   |
   |                   |                  |                   |
   |  (if ask)         |                  |                   |
   |  event: tool_     |                  |                   |
   |  approval_required|                  |                   |
   |<------------------|                  |                   |
   |  tool.approve /   |                  |                   |
   |  tool.deny        |                  |                   |
   |------------------>|                  |                   |
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
4. If the LLM requests a tool call, `ApprovalGate` evaluates it against the worker's rulesets: `allow` proceeds to dispatch, `deny` returns an error message to the LLM, `ask` emits a `tool_approval_required` event and waits for the client to respond via `tool.approve` or `tool.deny`
5. Once approved (or if auto-allowed), the server dispatches the tool call to the bound worker via `ToolDispatch`
6. Worker executes the tool and returns the result via `worker.toolResult`
7. Server feeds the result back to the LLM and continues streaming
8. When the LLM finishes (no more tool calls), server emits `turn_complete` with the final message
9. Server checks if context usage ≥80% — if so, runs summarization and emits `context_compacted`
10. The agent loop may repeat steps 3-8 multiple times (up to `maxSteps`, default 10)

### Subagent Flow

When the LLM calls the `task` tool, the server orchestrates a subagent internally:

```
 Parent Session        Server                     Worker
   |                     |                          |
   |  task tool call     |                          |
   |  { agentType,       |                          |
   |    prompt }         |                          |
   |-------------------->|                          |
   |                     |  create child session    |
   |                     |  (metadata.subagent)     |
   |                     |                          |
   |                     |  set agent permission    |
   |                     |  on ApprovalGate         |
   |                     |                          |
   |                     |  run Agent (same worker) |
   |                     |------------------------->|
   |                     |                          |
   |  subagent_event     |  child events            |
   |  (wrapped)          |<-------------------------|
   |<--------------------|                          |
   |                     |                          |
   |                     |  child turn complete     |
   |                     |<-------------------------|
   |                     |                          |
   |  <task_result>      |  cleanup child session   |
   |  returned to LLM    |  clear approval gate     |
   |                     |                          |
```

- Child session uses the **same worker** as the parent
- All child events are forwarded to the parent wrapped in `subagent_event` envelopes
- Approval events from the child are forwarded to the parent's clients and handled identically
- Parent abort propagates to the child
- Subagents **cannot nest** — a `task: deny` rule is always appended to every agent's permission set

## Event System

The server uses an internal **EventBus** for per-session pub/sub:

- **Producers**: `AgentRunner` emits events as the agent executes (status changes, content deltas, tool calls, errors)
- **Consumers**: Client subscriptions via `agent.onEvents` receive events in real-time
- Events are scoped to a session ID — clients only receive events for sessions they subscribe to
- 9 event types: `status_change`, `content_delta`, `tool_call_start`, `tool_call_end`, `turn_complete`, `error`, `tool_approval_required`, `context_compacted`, `subagent_event`

### ApprovalGate

Intercepts LLM tool calls before they reach ToolDispatch:

- Evaluates each tool call against up to three rule layers: agent permissions (subagent sessions only), static rules from `permissions.jsonc`, and runtime "always approve" patterns
- Three outcomes: `allow` (proceed silently), `deny` (block with error message to LLM), `ask` (emit `tool_approval_required` event and wait for user response)
- Manages pending approval promises: clients respond via `tool.approve` / `tool.deny`, which resolves or rejects the promise
- "Always approve" adds patterns to both a runtime in-memory layer and the persisted `permissions.jsonc` file, then cascade-checks other pending requests
- On session eviction or server shutdown, all pending approvals for the affected sessions are rejected

See [Tool Approval](/server/tool-approval) for the full reference.

See [Protocol Reference](/reference/protocol) for the full event type definitions.

## Key Abstractions

### AgentRunner

Orchestrates agent execution on the server side:

- Maintains a cache of `Agent` instances per session (loaded on demand, evicted after 30 min idle)
- On each prompt: loads session, resolves the model (prompt-level > session > server default), resolves worker, builds remote tools, builds system prompt, runs the agent
- Resolves the model for each prompt using a three-level priority chain: per-prompt model parameter > per-workspace model override > server default (`MOLF_DEFAULT_MODEL`)
- Integrates with `ApprovalGate` to evaluate tool calls before dispatching them to the worker
- Enforces a 30-minute turn timeout (increased from 10 minutes to accommodate approval wait time)
- Maps internal agent events to `AgentEvent` types and publishes them to the EventBus
- Persists messages to the session after each turn
- Performs automatic context summarization when the context window nears capacity
- Handles tool attachments (images inlined to LLM, other binary passed as file data) and runs server-side tool enhancement hooks
- Orchestrates subagent execution: builds the `task` tool when agents are available, creates child sessions, forwards events wrapped in `subagent_event` envelopes to the parent session's EventBus

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

- Workers: registered with their tools, skills, agents, and metadata (workdir, AGENTS.md content)
- Clients: registered with a client ID and name
- Provides lookups by worker ID, connection-to-worker mapping, and worker listing

## Server Module Table

| Module | File | Responsibility |
|--------|------|----------------|
| main | `src/main.ts` | Entry point: CLI args, config, start server, print auth token, signal handling |
| server | `src/server.ts` | Create WebSocket server, initialize all components, initialize provider system, handle connection lifecycle |
| config | `src/config.ts` | Load `molf.yaml`, parse CLI args |
| auth | `src/auth.ts` | Token generation, SHA-256 hashing, verification; stores hash in `server.json` |
| context | `src/context.ts` | `ServerContext` interface (includes `providerState`), `authedProcedure` middleware |
| router | `src/router.ts` | Complete tRPC router with 8 sub-routers: session, agent, tool, worker, fs, provider, workspace, cron |
| session-mgr | `src/session-mgr.ts` | `SessionManager`: in-memory cache + disk persistence |
| event-bus | `src/event-bus.ts` | `EventBus`: per-session pub/sub for agent events |
| agent-runner | `src/agent-runner.ts` | `AgentRunner`: agent instance cache, prompt orchestration, model resolution, event mapping, automatic context summarization |
| subagent-types | `src/subagent-types.ts` | `resolveAgentTypes()`: merges server defaults (explore, general) with worker-provided agents; enforces no-nesting |
| tool-dispatch | `src/tool-dispatch.ts` | `ToolDispatch`: promise-based tool call routing to workers |
| approval/ | `src/approval/*.ts` | Tool approval gate — `ApprovalGate`, `RulesetStorage`, `evaluate`, `expand`, `fromConfig`/`toConfig`, `findMatchingRules`, `shell-parser`. Evaluates tool calls against per-worker flat rulesets (last matching rule wins), manages pending approval promises. See [Tool Approval](/server/tool-approval). |
| tool-enhancements | `src/tool-enhancements.ts` | Server-side hooks for tool execution (beforeExecute/afterExecute); handles nested instruction injection |
| worker-dispatch | `src/worker-dispatch.ts` | `WorkerDispatch<T, R>`: generic dispatch pattern with queue and timeout |
| upload-dispatch | `src/upload-dispatch.ts` | `UploadDispatch`: file upload routing to workers |
| fs-dispatch | `src/fs-dispatch.ts` | `FsDispatch`: filesystem read routing to workers (for truncated output retrieval) |
| connection-registry | `src/connection-registry.ts` | `ConnectionRegistry`: tracks connected workers and clients |
| inline-media-cache | `src/inline-media-cache.ts` | `InlineMediaCache`: image byte cache for re-inlining (8h TTL, 200MB max) |
| attachment-resolver | `src/attachment-resolver.ts` | `AttachmentResolver`: resolves file refs and attachments for LLM calls |
| workspace-store | `src/workspace-store.ts` | `WorkspaceStore`: per-worker workspace persistence (`data/workers/{id}/workspaces/`) |
| workspace-notifier | `src/workspace-notifier.ts` | `WorkspaceNotifier`: emits workspace events (`session_created`, `config_changed`, `cron_fired`) |
| runtime-context | `src/runtime-context.ts` | Injects runtime context (current time, timezone) into LLM system prompts |
| cron-service | `src/cron-service.ts` | `CronService`: schedules and fires cron jobs, manages timers |
| cron-store | `src/cron-store.ts` | `CronStore`: persists cron jobs to `data/workers/{id}/workspaces/{id}/cron/jobs.json` |
| cron-tool | `src/cron-tool.ts` | Server-side `cron` tool definition for LLM-driven cron management |
| cron-time | `src/cron-time.ts` | Cron schedule parsing and next-fire-time calculation |
| subagent-runner | `src/subagent-runner.ts` | `SubagentRunner`: orchestrates subagent lifecycle (child session, event forwarding, cleanup) |

## Worker Module Table

| Module | File | Responsibility |
|--------|------|----------------|
| main | `src/main.ts` | Entry point: CLI args, start worker |
| connection | `src/connection.ts` | `WorkerConnection`: WebSocket with reconnection (exponential backoff) |
| identity | `src/identity.ts` | Worker UUID persistence in `{workdir}/.molf/worker.json` |
| tool-executor | `src/tool-executor.ts` | Execute tool calls, path resolution, structured result envelopes (`ToolResultEnvelope`) |
| skills | `src/skills.ts` | Load skills from `{workdir}/.agents/skills/{name}/SKILL.md` (or `.claude/skills/`) |
| agents | `src/agents.ts` | Load agent definitions from `{workdir}/.agents/agents/*.md` (or `.claude/agents/`); YAML frontmatter parsing |
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
- [Tool Approval](/server/tool-approval) — full reference for the approval gate, rulesets, and shell parsing
- [Worker Overview](/worker/overview) — running a worker, identity, reconnection
- [Sessions](/server/sessions) — session lifecycle and persistence
- [Protocol Reference](/reference/protocol) — full tRPC API with all procedures and event types
