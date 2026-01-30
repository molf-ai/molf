# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run all tests across all packages
bun run test

# Run a single test file
bun test packages/agent-core/tests/config.test.ts

# Type-check individual packages
bunx tsc --noEmit -p packages/agent-core/tsconfig.json
bunx tsc --noEmit -p packages/tui/tsconfig.json
bunx tsc --noEmit -p packages/protocol/tsconfig.json
bunx tsc --noEmit -p packages/server/tsconfig.json
bunx tsc --noEmit -p packages/worker/tsconfig.json

# Start the server (default: ws://127.0.0.1:7600)
bun run dev:server
bun run dev:server -- --config path/to/molf.yaml

# Start a worker (requires --name and --token)
bun run dev:worker -- --name my-worker --token <token>

# Launch TUI client (requires MOLF_TOKEN env var)
MOLF_TOKEN=<token> bun run dev:tui

# Run examples (standalone, no server needed)
bun run packages/agent-core/examples/simple-chat.ts
bun run packages/agent-core/examples/chat-with-tools.ts
```

## Architecture

Bun monorepo with five packages under `packages/`:

**`@molf-ai/agent-core`** — Zero-UI agent orchestration wrapping `@tanstack/ai` + `@tanstack/ai-gemini`.

- `Agent` is the main entry point. `Agent.prompt(text)` drives the loop: adds user message to `Session`, creates a Gemini adapter via `geminiText()`, calls `chat()` from `@tanstack/ai`, iterates the async `StreamChunk` stream, emits `AgentEvent` objects, and appends the assistant response to the session.
- `Agent.onEvent(handler)` returns an unsubscribe function. Events are a discriminated union (`status_change | content_delta | tool_call_start | tool_call_end | turn_complete | error`).
- `AgentStatus` is a state machine: `idle → streaming ↔ executing_tool → idle | error | aborted`.
- `Session` manages `SessionMessage[]` history with `serialize()`/`static deserialize()` for persistence. Converts to `ModelMessage[]` for the LLM wire format.
- `ToolRegistry` is a Map-based store. Tools use zod v4 schemas for `inputSchema` and an async `execute` function.
- `AgentConfig` groups `llm` (provider, model, temperature, maxTokens, apiKey) and `behavior` (systemPrompt, maxIterations, agentLoopStrategy). Defaults: `gemini-2.5-flash`, 10 iterations. API key reads from `GEMINI_API_KEY` env var.
- Constructor accepts optional `existingSession` parameter to resume from a deserialized session.

**`@molf-ai/protocol`** — Shared types, Zod schemas, and tRPC router definition.

- `types.ts` — all shared TypeScript interfaces: `AgentEvent` (7 variants including `ToolApprovalRequiredEvent`), `SessionMessage`, `ToolCall`, `SessionFile`, `WorkerInfo`, `ServerConfig`, etc.
- `schemas.ts` — Zod v4 validation schemas for all tRPC procedure inputs/outputs.
- `router.ts` — `AppRouter` type definition with typed stubs for 4 sub-routers: `session`, `agent`, `tool`, `worker`.
- `trpc.ts` — shared tRPC init with `TRPCContext` (token, clientId).

**`@molf-ai/server`** — tRPC WebSocket server that coordinates workers and clients.

- `server.ts` — `startServer(config)` creates a `ws` WebSocketServer with tRPC handler. Default port 7600.
- `auth.ts` — SHA-256 token auth. `initAuth(dataDir)` generates a token, stores hash in `server.json`. Supports `MOLF_TOKEN` env var override.
- `config.ts` — loads `molf.yaml` (YAML) or returns defaults. `parseCliArgs()` reads `--config`.
- `session-mgr.ts` — `SessionManager`: CRUD for sessions with in-memory cache + JSON file persistence in `<dataDir>/sessions/`.
- `event-bus.ts` — `EventBus`: per-session pub/sub for `AgentEvent` streaming to clients.
- `tool-dispatch.ts` — `ToolDispatch`: routes tool calls to workers via async generator subscription pattern.
- `agent-runner.ts` — `AgentRunner`: orchestrates LLM per session, builds remote tools that dispatch via `ToolDispatch`, forwards events to `EventBus`.
- `connection-registry.ts` — `ConnectionRegistry`: tracks connected workers and clients.
- `router.ts` — full tRPC router implementation with authed procedures.
- `context.ts` — `ServerContext` interface, `authedProcedure` middleware.

**`@molf-ai/worker`** — Connects to server, executes tool calls locally.

- `connection.ts` — `connectToServer(opts)`: WebSocket + tRPC client, registers with server, subscribes to `worker.onToolCall`, executes tools and returns results.
- `tool-executor.ts` — `ToolExecutor`: registers tools, converts zod schemas to JSON Schema, executes tool calls.
- `identity.ts` — `getOrCreateWorkerId(workdir)`: persistent UUID in `<workdir>/.molf/worker.json`.
- `skills.ts` — `loadSkills(workdir)`: loads from `<workdir>/skills/*/SKILL.md` with YAML frontmatter. `loadAgentsDoc(workdir)`: loads `AGENTS.md`.
- CLI args: `--name` (required), `--workdir`, `--server-url`, `--token`.

**`@molf-ai/tui`** — Ink (React for CLI) terminal interface connecting to the server.

- `useServer()` hook connects to the server via tRPC WebSocket client. Manages sessions, subscribes to `agent.onEvents`, returns `sendMessage`, `abort`, `reset`, `approveToolCall`, `denyToolCall`.
- `<App>` composes: `<ChatHistory>` (Ink `<Static>`) → `<ToolCallDisplay>` → `<StreamingResponse>` → `<StatusBar>` (spinner) → `<ToolApprovalPrompt>` → `<InputBar>` (`ink-text-input`). Escape aborts or exits.
- Reads env vars: `MOLF_TOKEN` (required), `MOLF_SERVER_URL`, `MOLF_WORKER_ID`, `MOLF_SESSION_ID`.

## Data Flow

```
TUI Client ──tRPC/WS──→ Server ──tRPC/WS──→ Worker
   │                       │                    │
   │  agent.prompt()       │  agent-runner      │
   │  agent.onEvents()     │  event-bus         │
   │                       │  tool-dispatch     │
   │                       │                    │  tool-executor
   │  ←── AgentEvent ──────│←── AgentEvent ─────│
   │                       │                    │
   │                       │── ToolCallReq ────→│
   │                       │←── ToolResult ─────│
```

## Key Dependencies

- `@tanstack/ai` — `chat()` function, `StreamChunk` types, `maxIterations` strategy
- `@tanstack/ai-gemini` — `geminiText(model, { apiKey })` adapter; model param requires `GeminiTextModel` type
- `@trpc/server` + `@trpc/client` v11 — typed RPC over WebSocket
- `ws` — WebSocket implementation for server and worker
- `zod` v4 (required by `@tanstack/ai-gemini`; v3 will fail with `toJSONSchema` export error)
- `yaml` — server config file parsing
- `ink` v5, `react` 18 — TUI rendering

## Environment Variables

| Variable | Used By | Description |
|---|---|---|
| `GEMINI_API_KEY` | agent-core | Gemini API key for LLM calls |
| `MOLF_TOKEN` | server, worker, tui | Auth token (server generates one if not set) |
| `MOLF_SERVER_URL` | worker, tui | WebSocket URL (default: `ws://127.0.0.1:7600`) |
| `MOLF_WORKER_ID` | tui | Target worker for new sessions |
| `MOLF_SESSION_ID` | tui | Resume an existing session |

## Conventions

- Tests use `bun:test` (`describe`, `test`, `expect`). No vitest.
- ESM throughout (`"type": "module"`, `.js` extensions in imports).
- Zod v4 API: `z.record(z.string(), z.unknown())` requires 2 args (not 1 like v3).
- The `refs/` and `docs/` directories are reference material, not project code — exclude from test runs and searches.
