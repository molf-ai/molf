# Architecture

Molf Assistant is a monorepo with 10 packages under `packages/`, managed by pnpm workspaces. A central tRPC WebSocket server orchestrates LLM interactions while workers execute tool calls locally. Clients connect over WebSocket to drive conversations.

## Package Overview

| Package | Description |
|---------|-------------|
| `protocol` | Shared types, Zod schemas, tRPC router type definition, plugin system, credentials, TLS trust, tool definitions, truncation, WebSocket helpers |
| `agent-core` | Agent class (manual step loop with `streamText`), Session, context pruner, provider registry/catalog, system prompts |
| `server` | WebSocket server (tRPC v11), SessionManager, AgentRunner, EventBus, ToolDispatch, ApprovalGate, ConnectionRegistry, WorkspaceStore, PluginLoader, SubagentRunner |
| `worker` | ToolExecutor, skill/agent loading, server connection with auto-reconnect, StateWatcher, SyncCoordinator, worker plugin loader |
| `client-tui` | Ink 5 + React 18 terminal client |
| `client-telegram` | Telegram bot client via grammY framework |
| `plugin-cron` | Default server plugin: cron job scheduling with routes and session tool |
| `plugin-mcp` | Default worker plugin: MCP client integration (stdio + HTTP transport) |
| `test-utils` | Shared test helpers: `mockStreamText`, `createTmpDir`, `createEnvGuard`, `getFreePort` |
| `e2e` | Integration and live test suites with server/worker test helpers |

## Dependency Graph

```
protocol
  ├──▲── agent-core
  │        ▲
  │        │
  │      server
  │
  ├──▲── worker
  ├──▲── client-tui
  ├──▲── client-telegram
  ├──▲── plugin-cron
  └──▲── plugin-mcp
```

`protocol` sits at the base. `agent-core` builds on `protocol` to provide the Agent class and provider system. `server` depends on both `protocol` and `agent-core`. All other packages (`worker`, clients, plugins) depend only on `protocol`.

## Communication

All communication uses tRPC v11 over WebSocket with TLS enabled by default. The server exposes 9 sub-routers:

| Router | Domain |
|--------|--------|
| `session` | Session lifecycle (create, list, load, delete, rename) |
| `agent` | LLM interaction (prompt, abort, events subscription) |
| `tool` | Tool approval (approve, deny, list) |
| `worker` | Worker registration, state sync, tool call dispatch |
| `fs` | File system reads (tool output retrieval) |
| `provider` | LLM provider and model listing |
| `workspace` | Workspace management and config |
| `auth` | Pairing codes, API key management |
| `plugin` | Plugin route dispatch |

See [Protocol](./protocol.md) for the full tRPC API reference.

## Message Flow

### Prompt Flow

```
Client                    Server                     Worker
  │                         │                          │
  ├─ agent.prompt ─────────►│                          │
  │                         ├─ AgentRunner.run()       │
  │                         ├─ streamText (LLM) ──►    │
  │                         │  ◄── tool_call           │
  │                         ├─ ToolDispatch ──────────►│
  │                         │                          ├─ ToolExecutor
  │                         │  ◄── toolResult ─────────┤
  │                         ├─ continue loop           │
  │                         │  ...                     │
  │  ◄── turn_complete ─────┤                          │
```

1. Client sends `agent.prompt` with session ID and text.
2. AgentRunner resolves the model (prompt-level > workspace config > server default), builds the system prompt, and calls `streamText` from Vercel AI SDK.
3. When the LLM emits tool calls, ToolDispatch routes them to the bound worker via promise queuing (120s timeout).
4. The worker executes the tool via ToolExecutor and returns the result.
5. The agent loop continues until the LLM produces a final response or `maxSteps` is reached.

### Event Flow

```
AgentRunner ──► EventBus ──► agent.onEvents subscription ──► Client
```

The AgentRunner emits events per session through the EventBus. Clients subscribe via `agent.onEvents` to receive streaming updates. Nine event types are emitted: `status_change`, `content_delta`, `tool_call_start`, `tool_call_end`, `turn_complete`, `error`, `tool_approval_required`, `context_compacted`, and `subagent_event`.

## Key Abstractions

### AgentRunner

Orchestrates LLM interactions. Maintains a cache of `Agent` instances per session (evicted after 30 minutes idle). Builds system prompts from default instructions, skill hints, task hints, workdir context, media references, and runtime context. Dispatches hooks at `turn_start`, `before_prompt`, `after_prompt`, and `turn_end`.

### ToolDispatch

Routes tool calls from the server to the connected worker. Uses promise queuing with a 120-second timeout. If a worker disconnects, all pending dispatches are rejected immediately.

### EventBus

Per-session event channels. AgentRunner publishes events; clients consume them via tRPC subscriptions.

### ConnectionRegistry

Tracks all connected WebSocket clients (workers and clients). Worker state persists across disconnects -- workers are marked offline rather than removed. Dispatches `worker_connect` and `worker_disconnect` hooks.

### ApprovalGate

Three-layer tool approval evaluation: agent permissions (subagent sessions only), static rules from `permissions.jsonc`, and runtime "always approve" patterns. See [Tool Approval](/server/tool-approval).

### PluginLoader

Loads server plugins from config, validates config against plugin schemas, and manages the plugin lifecycle. Tracks worker plugin specifiers to send to workers on connect. See [Plugins](./plugins.md).

### SessionManager

In-memory session cache with JSON file persistence at `{dataDir}/sessions/{id}.json`. Uses atomic writes (tmp file + rename). Dispatches `session_create`, `session_delete`, and `session_save` hooks.

### WorkspaceStore

Groups sessions into workspaces. Each workspace carries a per-workspace model config override. Persisted at `{dataDir}/workers/{workerId}/workspaces/{workspaceId}/workspace.json`.

## Server Module Table

| Module | Description |
|--------|-------------|
| `main.ts` | Entry point: CLI parsing, config resolution, LogTape setup, server start |
| `config.ts` | Config resolution (YAML + CLI + env), defaults |
| `server.ts` | WebSocket server initialization, TLS, component wiring |
| `router.ts` | tRPC router composition (9 sub-routers) |
| `context.ts` | tRPC context and middleware (auth) |
| `agent-runner.ts` | LLM orchestration, system prompt building, model resolution |
| `session-mgr.ts` | Session persistence and caching |
| `event-bus.ts` | Per-session event channels |
| `auth.ts` | Token verification, API key management |
| `tls.ts` | Self-signed certificate generation |
| `connection-registry.ts` | WebSocket client tracking |
| `worker-store.ts` | Worker state persistence |
| `worker-dispatch.ts` | Tool call, upload, and FS read dispatch to workers |
| `workspace-store.ts` | Workspace config and session grouping |
| `workspace-notifier.ts` | Workspace event subscriptions |
| `plugin-loader.ts` | Server plugin loading and lifecycle |
| `plugin-api.ts` | ServerPluginApi implementation |
| `plugin-routes.ts` | Plugin route tRPC integration |
| `summarization.ts` | Context summarization |
| `subagent-runner.ts` | Subagent session lifecycle |
| `subagent-types.ts` | Built-in agent definitions (explore, general) |
| `pairing.ts` | Pairing code store |
| `approval/approval-gate.ts` | Three-layer tool approval |
| `approval/evaluate.ts` | Pattern matching and rule evaluation |
| `approval/ruleset-storage.ts` | permissions.jsonc persistence |
| `approval/shell-parser.ts` | Shell command parsing for approval |

## Worker Module Table

| Module | Description |
|--------|-------------|
| `index.ts` | Entry point: CLI, identity, TLS, connection, plugin loading |
| `cli.ts` | CLI argument parsing |
| `identity.ts` | Persistent worker UUID |
| `connection.ts` | Server connection with auto-reconnect |
| `tool-executor.ts` | Tool registration and execution |
| `skills.ts` | Skill and AGENTS.md loading |
| `agents.ts` | Agent definition loading |
| `state-watcher.ts` | File system watching for skills/agents changes |
| `sync-coordinator.ts` | Serialized state sync to server |
| `plugin-loader.ts` | Worker plugin loading |
| `plugin-api.ts` | WorkerPluginApi implementation |
| `pair.ts` | TOFU + pairing code exchange |
| `truncation.ts` | Tool output truncation and storage |

## See also

- [Protocol](./protocol.md) -- full tRPC API reference
- [Plugins](./plugins.md) -- plugin and hook system
- [Logging](./logging.md) -- structured logging configuration
