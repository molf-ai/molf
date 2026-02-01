# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Molf Assistant is an AI agent with a client-server-worker architecture. A central tRPC WebSocket server coordinates LLM interactions (Gemini via Vercel AI SDK) while workers execute tool calls locally. A terminal UI (Ink/React) serves as the client.

## Commands

```bash
# Install dependencies
bun install

# Run all tests (unit + integration + e2e)
bun run test

# Run unit tests only
bun run test:unit

# Run e2e integration tests
bun run test:e2e

# Run tests for a specific package
bun test packages/server/tests/
bun test packages/agent-core/tests/

# Run a single test file
bun test packages/server/tests/session-mgr.test.ts

# Run tests with coverage
bun run test:coverage

# Type-check a package
bunx tsc --noEmit -p packages/server/tsconfig.json

# Start development (three separate terminals)
bun run dev:server
bun run dev:worker -- --name my-worker
bun run dev:client-tui
```

## Architecture

**Monorepo** with Bun workspaces. All packages live under `packages/`.

For detailed server internals (modules, config, auth, tool dispatch, agent execution flow, protocol details), see [`docs/server-architecture.md`](docs/server-architecture.md).

### Package Dependency Flow

```
protocol  (shared types, Zod schemas, tRPC router definition)
    ↑
agent-core  (Agent class, Session, ToolRegistry, system prompts)
    ↑
server  (WebSocket server, SessionManager, AgentRunner, ToolDispatch, EventBus)

protocol
    ↑
worker  (ToolExecutor, skill loading, server connection)

protocol
    ↑
client-tui  (Ink/React terminal client, tRPC client, commands, hooks)
```

### Communication

All communication is over WebSocket using tRPC. The router has four domains:
- **session** — CRUD for sessions (persisted as JSON in `data/sessions/`)
- **agent** — prompt submission, abort, event subscriptions, status
- **tool** — list tools, approve/deny tool calls
- **worker** — register, rename, receive tool call assignments

### Key Patterns

- **Event-driven**: Agents emit events (status_change, content_delta, tool_call_start/end, turn_complete, error). Clients subscribe via tRPC subscriptions. Server uses an internal EventBus.
- **Tool approval workflow**: Server can emit `tool_approval_required`; clients approve/deny before execution proceeds.
- **Skill system**: Workers load skills from `skills/<name>/SKILL.md` (Markdown with YAML frontmatter) and instructions from `AGENTS.md` in the workdir root.
- **Session persistence**: Sessions stored as JSON files under `data/sessions/{id}.json`, cached in memory during use.

## Testing

Uses Bun's built-in test runner (`bun:test`). **All new code must be covered by tests.** Run `bun run test:coverage` to verify — the report shows % Funcs and % Lines per file.

### Test Tiers

| Tier | Location | What it tests | Command |
| ---- | -------- | ------------- | ------- |
| **Unit** | `packages/{pkg}/tests/` | Individual modules in isolation (mocked deps) | `bun run test:unit` |
| **Integration** | `packages/e2e/tests/integration/` | Full server + worker + client flows with mocked LLM | `bun run test:e2e` |
| **Live / Smoke** | `packages/e2e/tests/live/` | Real Gemini API calls (text generation + tool use) | `bun run test:live` |

- `bun run test` — runs unit + integration (no live).
- `bun run test:all` — includes live tests.
- `bun run test:ci` — bail on first failure.

### Integration Tests

Located in `packages/e2e/tests/integration/`. These spin up real server and worker instances (using helpers from `packages/e2e/helpers/`) and exercise full workflows: session lifecycle, multi-worker routing, concurrent sessions, worker reconnection, and tool approval. LLM calls are mocked via `packages/test-utils/src/mock-stream.ts`.

### Live / Smoke Tests

Located in `packages/e2e/tests/live/`. Require `GEMINI_API_KEY` env var and `MOLF_LIVE_TEST=1`. These are smoke tests that hit the real Gemini API to verify text streaming and tool call round-trips work end-to-end.

### Test Utilities

- **`packages/test-utils/`** — Shared helpers: `createTmpDir()` (isolated temp dirs), `createEnvGuard()` (temporary env vars), `getFreePort()` (OS-allocated ports), `mockStreamText()` / `mockToolCallResponse()` (AI SDK mocking).
- **`packages/e2e/helpers/`** — `startTestServer()` and `connectTestWorker()` for spinning up real instances, `waitForEvent()` for subscription assertions.

### Key Convention

Module mocks must be set up **before** imports (Bun test requirement):

```typescript
import { mock } from "bun:test";
mock.module("ai", () => ({ streamText: mockStreamText(...) }));
const { Agent } = await import("../src/agent.js");
```

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ESNext target)
- **LLM**: Gemini via Vercel AI SDK (`ai`, `@ai-sdk/google`)
- **RPC**: tRPC v11 over WebSocket (`ws`)
- **Validation**: Zod 4
- **TUI**: Ink 5 + React 18
