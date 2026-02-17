# Architecture Comparison: Molf vs Reference Projects

## Overview Table

| | **Molf** | **Moltis** | **Nanobot** | **OpenClaw** | **OpenCode** | **PicoClaw** |
|---|---|---|---|---|---|---|
| **Language** | TypeScript/Bun | Rust | Python | TypeScript/Node | TypeScript/Bun | Go |
| **Architecture** | Client-Server-Worker | Single binary gateway | Monolith | Gateway-centric | Client-Server | Single binary |
| **LLM SDK** | Vercel AI SDK | Raw HTTP per provider | Raw HTTP | Embedded Pi-Mono | Vercel AI SDK | Raw HTTP |
| **Transport** | tRPC/WebSocket | Custom WS RPC v3 | WebSocket | Custom WS JSON | Hono REST+WS | HTTP API |
| **Sessions** | JSON files | JSONL + SQLite | JSONL | JSONL | SQLite + Drizzle | JSONL |
| **Providers** | Gemini (primary) | 6+ with failover chain | Multi-provider | Multi-provider | 21+ providers | Multi-provider |
| **Maturity** | Early | Production | Production | Production | Production | Early |

---

## What Molf Does Better

### 1. Clean separation of concerns via monorepo packages

The `protocol -> agent-core -> server` dependency chain is one of the cleanest across all projects. Each package has a well-defined boundary. Nanobot is a monolith. PicoClaw mixes concerns. OpenClaw has 45+ subsystems in a single `src/` tree without clear package boundaries.

### 2. Type-safe RPC with tRPC

Using tRPC gives end-to-end type safety between client and server for free. Moltis, OpenClaw, and Nanobot all use custom JSON frame protocols that require manual schema synchronization. OpenCode uses Hono which is close but less elegant for bidirectional communication.

### 3. Decoupled worker model

The server-worker split (server orchestrates LLM, worker executes tools) is a genuine architectural advantage. Tools run on the worker's machine with the worker's filesystem access while the server stays clean. No other reference project has this -- they all run tools in-process or in a sandbox on the same machine.

### 4. Lazy skill loading via tool

The pattern of exposing skills as a `skill(name)` tool the LLM calls on-demand is clever -- avoids paying token cost for unused skills. Moltis and OpenClaw inject all discovered skill instructions into the system prompt upfront, wasting context window.

---

## What the Reference Projects Do Better

### 1. Provider failover (Moltis, OpenCode, OpenClaw)

This is the biggest gap. Molf is tightly coupled to Gemini. All three mature projects implement:
- **Provider chain with automatic failover** on rate limits, auth errors, server errors
- **Circuit breakers** per provider (disable after N failures, auto-recover)
- **Error classification** (retryable vs fatal, context-window vs quota)

Molf has none of this. A single Gemini outage means total failure.

### 2. Lifecycle hooks (Moltis, OpenClaw, OpenCode)

All three implement a hook system that lets plugins intercept the agent pipeline:
- `BeforeToolCall` / `AfterToolCall` -- modify, block, or audit tool executions
- `BeforeLLMCall` / `AfterLLMCall` -- transform prompts or responses
- `MessageSending` -- pre-process outbound messages

Molf's EventBus is read-only (emit/subscribe). It can't intercept or modify behavior. This severely limits extensibility.

### 3. Human-in-the-loop approval (Moltis, OpenClaw, OpenCode)

All reference projects have command approval workflows:
- Safe command allowlists (74+ commands in Moltis)
- Approval modes: Off / OnMiss / Always
- Broadcast approval requests to operator clients
- Timeout with configurable defaults

Molf has `tool_approval_required` events but the implementation appears minimal compared to these mature systems.

### 4. Session compaction (Moltis, OpenClaw, OpenCode)

When sessions grow too large:
- Moltis auto-compacts at 95% context usage using LLM summarization, persists key facts to vector memory
- OpenCode has a dedicated compaction agent
- OpenClaw does the same with hook points for plugins

Molf has context pruning (trim old tool results) but no semantic compaction -- just truncation. Information is lost permanently rather than summarized.

### 5. Memory/embeddings search (Moltis, OpenClaw, OpenCode)

Vector + full-text hybrid search for persistent agent memory:
- Moltis: SQLite-vec, auto-indexing session summaries
- OpenClaw: Multi-provider embeddings (OpenAI, Gemini, Voyage, local)
- OpenCode: Similar approach

Molf has no persistent memory system at all.

### 6. MCP support (Moltis, OpenCode)

Model Context Protocol is becoming the standard for tool interoperability:
- Moltis: Full MCP client (stdio + SSE), health polling, auto-restart on crash
- OpenCode: Full MCP client with OAuth for remote servers, dynamic tool discovery

Molf has no MCP support.

### 7. Plugin/extension system (OpenClaw, OpenCode)

- OpenClaw: Jiti-based dynamic loading, manifest registry, file watcher for hot reload
- OpenCode: npm-based plugin install at runtime, hook registration, tool injection

Molf has the skill system but no general plugin mechanism.

### 8. Security depth (Moltis)

Moltis stands out here:
- `secrecy::Secret<T>` for secret handling (redacts Debug, zeros on drop)
- SSRF protection (DNS resolution, IP blocklists)
- Docker/Apple Container sandboxing for all execution
- Origin header validation against CSWSH
- WebAuthn passkey auth
- No `unsafe` code enforced by lints

Molf has bearer token auth and that's about it.

### 9. Multi-channel support (OpenClaw, Nanobot, PicoClaw)

OpenClaw supports 12+ channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Matrix, etc.) through a unified gateway. Nanobot and PicoClaw support WhatsApp, Telegram, and Feishu. Molf has a Telegram client but no unified channel abstraction.

### 10. Database-backed sessions (OpenCode)

OpenCode uses SQLite + Drizzle ORM with proper migrations, foreign keys, WAL mode, and structured session/message/part tables. This enables session forking, querying, and reliable concurrent access. Molf's JSON files work but won't scale and don't support queries.

---

## Architectural Lessons Worth Adopting

### Priority 1 -- High value, moderate effort

1. **Provider abstraction + failover chain** -- The `ProviderRegistry` already exists in `agent-core/src/providers/`. Add error classification and a chain with circuit breakers. Copy the pattern from Moltis.
2. **Session compaction** -- The context pruner already detects pressure. Add an LLM-based summarization step instead of just truncating.

### Priority 2 -- Medium value

3. **Modifying hooks** -- Upgrade the EventBus from read-only to support `BeforeToolCall` hooks that can block or modify. This unlocks plugin extensibility and better approval workflows.
4. **MCP client** -- The Vercel AI SDK has experimental MCP support. Would integrate naturally.

### Priority 3 -- Nice to have

5. **SQLite for sessions** -- Consider for when querying, session search, or forking is needed.
6. **Memory/embeddings** -- Persistent memory for long-lived agents.

---

## Overall Assessment

Molf's core architecture (the client-server-worker split with tRPC) is **cleaner and better-separated** than any reference project. The dependency flow is the best of the bunch.

But the reference projects are **significantly more mature** in operational concerns: resilience (provider failover, circuit breakers), security (sandboxing, SSRF, secret handling), extensibility (hooks, plugins, MCP), and long-session management (compaction, memory).

The good news: the foundation is solid and these features can be layered on incrementally. The provider registry and context pruner already provide natural extension points for the most impactful improvements (failover and compaction).

---

## Reference Projects Summary

### Moltis (Rust)
Single binary AI gateway with 30+ crates. Defense-in-depth security (WebAuthn, SSRF protection, sandbox execution, secret redaction). Provider chain with circuit breakers. 17-event lifecycle hook system with read/write semantics. JSONL + SQLite sessions with auto-compaction. Full MCP client.

### Nanobot (Python)
Ultra-lightweight (~3,663 lines core). Async-first with LiteLLM multi-provider abstraction. Two-layer memory (MEMORY.md + HISTORY.md). 9 chat platform integrations via decoupled message bus. Registry-driven provider system. MCP support. Cron + heartbeat services.

### OpenClaw (TypeScript/Node)
Multi-channel personal assistant with gateway-centric architecture. 12+ channel integrations. Device-based pairing security. Plugin system with deep hooks (LLM, message, session, tool-call). Embedded Pi-Mono agent runtime. Vector + FTS hybrid memory search. ACP protocol bridge. Auth profile failover with cooldown.

### OpenCode (TypeScript/Bun)
Provider-agnostic coding agent (~45k lines). 21+ LLM providers via Vercel AI SDK. SQLite + Drizzle ORM for sessions with forking support. Fine-grained permission system (allow/deny/ask per agent per tool). Full MCP client with OAuth. Plugin system loaded from npm at runtime. ACP protocol for IDE integration. Dedicated compaction agent.

### PicoClaw (Go)
Ultra-lightweight single binary (<10MB, <10MB RAM). Multi-provider via OpenRouter + direct APIs. 26+ tools including hardware I2C/SPI. Async subagent spawning. Multi-channel (13+ adapters). Workspace-based config with embedded templates. Smart context summarization. Targets constrained hardware (RISC-V boards).
