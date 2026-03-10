# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Molf Assistant is an AI agent with a client-server-worker architecture. A central tRPC WebSocket server coordinates LLM interactions (Gemini or Anthropic via Vercel AI SDK) while workers execute tool calls locally. A terminal UI (Ink/React) serves as the client.

## Commands

```bash
pnpm install

# Dev (three separate terminals)
pnpm dev:server
pnpm dev:worker -- --name my-worker
pnpm dev:client-tui

# Tests
pnpm test                 # unit + integration
pnpm test:unit
pnpm test:e2e
pnpm test:coverage
pnpm vitest run packages/server/tests/session-mgr.test.ts  # single file

# Type-check
pnpm exec tsc --noEmit -p packages/server/tsconfig.json
```

## Architecture

Monorepo with pnpm workspaces. All packages live under `packages/`.

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
- **Skill system**: Workers load `.agents/skills/<name>/SKILL.md` (or `.claude/skills/` as fallback) on startup. Skills are lazy — the LLM calls a `skill` tool to load them on demand. `AGENTS.md` (or `CLAUDE.md` as fallback) at the workdir root is always injected into the system prompt.
- **Session persistence**: JSON files under `data/sessions/{id}.json`, in-memory cache during use.
- **Auth**: Token-based. Server prints a token on startup; hash stored in `data/server.json`. Set `MOLF_TOKEN` env var for a fixed token across restarts.
- **Logging**: Structured logging via [LogTape](https://logtape.org/). Each process calls `configure()` at startup; `agent-core` only uses `getLogger()`. Control with `MOLF_LOG_LEVEL` (default: `"info"`) and `MOLF_LOG_FILE` (`"none"` to disable). Logs go to `{dataDir}/logs/` (server) or `{workdir}/.molf/logs/` (worker).

For detailed docs see:
- [`docs/reference/architecture.md`](docs/reference/architecture.md) — package graph, message flow, key abstractions, module table
- [`docs/reference/protocol.md`](docs/reference/protocol.md) — full tRPC API, event types, core types
- [`docs/reference/testing.md`](docs/reference/testing.md) — test utilities, integration helpers, mock patterns
- [`docs/reference/logging.md`](docs/reference/logging.md) — LogTape configuration, categories, levels, file locations
- [`docs/server/overview.md`](docs/server/overview.md) — running the server, auth, LLM providers
- [`docs/worker/skills.md`](docs/worker/skills.md) — SKILL.md format, AGENTS.md vs skills

## Testing

Uses Vitest. All new code must have test coverage.

| Tier | Location | Command |
|------|----------|---------|
| Unit | `packages/{pkg}/tests/` | `pnpm test:unit` |
| Integration | `packages/e2e/tests/integration/` | `pnpm test:e2e` |
| Live | `packages/e2e/tests/live/` | `pnpm test:live` (needs `GEMINI_API_KEY` + `MOLF_LIVE_TEST=1`) |

**Critical convention** — `vi.mock` is hoisted automatically, so static imports work:

```typescript
import { vi } from "vitest";
vi.mock("ai", () => ({ streamText: mockStreamText(...) }));
import { Agent } from "../src/agent.js";
```

**Test utilities** (`packages/test-utils/`): `createTmpDir()`, `createEnvGuard()`, `getFreePort()`, `mockStreamText()`, `mockToolCallResponse()`.

**Integration helpers** (`packages/e2e/helpers/`): `startTestServer()`, `connectTestWorker()`, `promptAndWait()`, `waitForEvent()`.

## Design Principles

- **No test-only mocks in production code.** Use `vi.mock`/spies in tests.
- **One implementation = no interface.** Extract an interface only when there are multiple concrete implementations.
- **Don't propagate options you don't use.** Every parameter is a commitment.
- **Solve the actual problem, not a general case.** Don't add abstractions for imagined future needs.
- **No leaky abstractions.** Each layer owns its domain; don't expose implementation details across layers.

## Working on This Codebase — Required Practices

### Before Designing: Clarify First, Then Propose

1. **Identify which package/layer the change belongs to.** Ask: "Does this code run on the server, worker, or client?" Tool execution happens on the **worker**. LLM orchestration happens on the **server**. Never put worker-side logic in the server or vice versa.
2. **Check if existing tools/APIs already solve the problem.** Don't create new abstractions when existing ones suffice (e.g. don't propose `memory_write` when `write_file` exists).
3. **If the user's request is ambiguous, ask one clarifying question** before designing. Don't guess and iterate 4 times.

### Proposing Solutions

- **Start with the simplest possible approach.** If the user wants more complexity, they'll say so. Predefined presets, tagging systems, multi-tool splits, and layered hierarchies are usually wrong on the first pass.
- **Present ONE approach with trade-offs**, not a menu of 4 options unless asked. If you have a recommendation, lead with it.
- **Think through multi-worker and edge cases before presenting**, not after the user asks "what about X?"

### When You're Uncertain

- **Say "I'm not sure about X" instead of confidently guessing.** Wrong confidence wastes more time than honest uncertainty.
- **Don't abandon a well-reasoned position just because the user pushes back.** Explain the trade-offs. If the user still prefers their approach after hearing the trade-offs, then implement it.

## Tech Stack

- **Runtime**: Node.js v24 + tsx | **Language**: TypeScript strict mode
- **LLM**: Gemini / Anthropic via Vercel AI SDK (`ai`, `@ai-sdk/google`, `@ai-sdk/anthropic`)
- **RPC**: tRPC v11 over WebSocket | **Validation**: Zod 4 | **TUI**: Ink 5 + React 18
