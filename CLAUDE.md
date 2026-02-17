# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Molf Assistant is an AI agent with a client-server-worker architecture. A central tRPC WebSocket server coordinates LLM interactions (Gemini or Anthropic via Vercel AI SDK) while workers execute tool calls locally. A terminal UI (Ink/React) serves as the client.

## Commands

```bash
bun install

# Dev (three separate terminals)
bun run dev:server
bun run dev:worker -- --name my-worker
bun run dev:client-tui

# Tests
bun run test              # unit + integration
bun run test:unit
bun run test:e2e
bun run test:coverage
bun test packages/server/tests/session-mgr.test.ts  # single file

# Type-check
bunx tsc --noEmit -p packages/server/tsconfig.json
```

## Architecture

Monorepo with Bun workspaces. All packages live under `packages/`.

**Package dependency flow:**

```
protocol  (shared types, Zod schemas, tRPC router definition)
    ↑
agent-core  (Agent class, Session, ToolRegistry, system prompts)
    ↑
server  (WebSocket server, SessionManager, AgentRunner, ToolDispatch, EventBus)

protocol ↑ worker       (ToolExecutor, skill loading, server connection)
protocol ↑ client-tui   (Ink/React terminal client)
protocol ↑ client-telegram  (Telegram bot via grammY)
```

**Communication:** All over WebSocket/tRPC. Four router domains: `session`, `agent`, `tool`, `worker`.

**Key patterns:**
- **Event-driven**: `AgentRunner` emits 7 event types (`status_change`, `content_delta`, `tool_call_start/end`, `turn_complete`, `error`, `tool_approval_required`) per session via `EventBus`. Clients subscribe via `agent.onEvents`.
- **Tool dispatch**: `ToolDispatch` routes LLM tool calls to the bound worker via promise queuing (120s timeout). Worker disconnect rejects all pending dispatches.
- **Skill system**: Workers load `skills/<name>/SKILL.md` on startup. Skills are lazy — the LLM calls a `skill` tool to load them on demand. `AGENTS.md` (or `CLAUDE.md` as fallback) at the workdir root is always injected into the system prompt.
- **Session persistence**: JSON files under `data/sessions/{id}.json`, in-memory cache during use.
- **Auth**: Token-based. Server prints a token on startup; hash stored in `data/server.json`. Set `MOLF_TOKEN` env var for a fixed token across restarts.

For detailed docs see:
- [`docs/reference/architecture.md`](docs/reference/architecture.md) — package graph, message flow, key abstractions, module table
- [`docs/reference/protocol.md`](docs/reference/protocol.md) — full tRPC API, event types, core types
- [`docs/reference/testing.md`](docs/reference/testing.md) — test utilities, integration helpers, mock patterns
- [`docs/server/overview.md`](docs/server/overview.md) — running the server, auth, LLM providers
- [`docs/worker/skills.md`](docs/worker/skills.md) — SKILL.md format, AGENTS.md vs skills

## Testing

Uses `bun:test`. All new code must have test coverage.

| Tier | Location | Command |
|------|----------|---------|
| Unit | `packages/{pkg}/tests/` | `bun run test:unit` |
| Integration | `packages/e2e/tests/integration/` | `bun run test:e2e` |
| Live | `packages/e2e/tests/live/` | `bun run test:live` (needs `GEMINI_API_KEY` + `MOLF_LIVE_TEST=1`) |

**Critical convention** — module mocks must be set up **before** imports:

```typescript
import { mock } from "bun:test";
mock.module("ai", () => ({ streamText: mockStreamText(...) }));
const { Agent } = await import("../src/agent.js");
```

**Test utilities** (`packages/test-utils/`): `createTmpDir()`, `createEnvGuard()`, `getFreePort()`, `mockStreamText()`, `mockToolCallResponse()`.

**Integration helpers** (`packages/e2e/helpers/`): `startTestServer()`, `connectTestWorker()`, `promptAndWait()`, `waitForEvent()`.

## Design Principles

- **No test-only mocks in production code.** Use `mock.module`/spies in tests.
- **One implementation = no interface.** Extract an interface only when there are multiple concrete implementations.
- **Don't propagate options you don't use.** Every parameter is a commitment.
- **Solve the actual problem, not a general case.** Don't add abstractions for imagined future needs.
- **No leaky abstractions.** Each layer owns its domain; don't expose implementation details across layers.

## Tech Stack

- **Runtime**: Bun | **Language**: TypeScript strict mode
- **LLM**: Gemini / Anthropic via Vercel AI SDK (`ai`, `@ai-sdk/google`, `@ai-sdk/anthropic`)
- **RPC**: tRPC v11 over WebSocket | **Validation**: Zod 4 | **TUI**: Ink 5 + React 18
