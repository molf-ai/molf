# Roadmap

This page collects all planned improvements to Molf Assistant. Items are grouped by area; no specific release timeline is attached to any entry.

## Agent Core

### Context Management

- **LLM-powered compaction** — when a hard-clear is not enough, summarize the conversation into a condensed form before discarding history (all reference projects do this).
- **Prune user/assistant messages** — the current pruner only trims tool results; long user/assistant turns accumulate unboundedly.
- **Escalating retry** — try compaction → retry with more aggressive compaction → fail gracefully (currently only one aggressive retry exists).
- **History/turn limiting** — cap the number of historical turns sent to the LLM (sliding window), independent of token-based pruning.
- **`context_compacted` event** — emit an event so the UI can inform the user that context was reduced.

### Message Queue

- **Prompt and shell command queue** — instead of rejecting with `CONFLICT` when the agent is busy, queue incoming requests and process them in order once the agent becomes idle.

### Prompt Caching

- **Anthropic cache-control / Gemini equivalent** — add prompt caching support with TTL synchronized to context pruning to reduce API costs on long sessions.

### Sub-agents

- **Subagent tool** — allow the agent to spawn isolated child agents to handle focused subtasks in the background, with results reported back to the parent session.

## Model & Provider Expansions

Molf currently supports two providers (Gemini and Anthropic) via the Vercel AI SDK. The `LLMProvider` interface makes adding new providers straightforward; the following are planned.

### Additional API-key Providers

| Provider | Notes |
|----------|-------|
| **OpenAI** | GPT-4o, GPT-4o-mini, o1, o3 and future releases via `@ai-sdk/openai` |
| **DeepSeek** | Cost-effective frontier reasoning models (DeepSeek-V3, R1) |
| **OpenRouter** | Single API key giving access to 100+ models from multiple vendors |
| **Azure OpenAI** | Enterprise deployments behind an Azure endpoint |
| **Custom OpenAI-compatible endpoint** | Point at any OpenAI-compatible server — vLLM, LM Studio, LocalAI, etc. |

### Local Models (No API Key)

- **Ollama** — run any GGUF-compatible model (Llama 3, Mistral, Phi, Qwen, DeepSeek-R1, etc.) entirely on-device; zero egress cost and full privacy.

### Subscription-based Auth (OAuth, No API Key)

These providers let you authenticate with an existing paid subscription instead of a raw API key, removing the need to generate or store separate credentials.

- **Anthropic via OAuth (Claude.ai subscription)** — authenticate using a Claude Max / Pro subscription via the same OAuth flow that Claude Code itself uses. No separate API key required.
- **OpenAI via OAuth (ChatGPT subscription)** — authenticate using a ChatGPT Plus or Pro subscription, identical to the flow used by open-source Claude Code alternatives.
- **GitHub Copilot** — authenticate with a GitHub token backed by an active Copilot subscription; routes requests through the Copilot inference endpoint.

### Provider Infrastructure

- **Per-model parameter overrides** — set temperature caps, token limits, or other parameters per model ID (needed for certain models like some reasoning models that restrict temperature).
- **Model catalog** — expose a `GET /models` endpoint so clients can list available models and their context windows without reading the server config.
- **Automatic model detection** — infer the correct provider from a model name prefix (`claude-*` → Anthropic, `gpt-*` → OpenAI, `gemini-*` → Gemini, etc.) so the provider field in `molf.yaml` becomes optional.
- **Failover / fallback** — configure a backup model to use if the primary model is unavailable or over quota.

## Memory System

The current context pruner discards content with no long-term storage. A persistent memory layer is planned across several tiers.

- **Key-fact extraction before compaction** — before clearing context, write important information to a persistent `MEMORY.md` file in the workdir so facts survive session resets.
- **Searchable history log** — maintain a `HISTORY.md` (or equivalent) with timestamped, grep-able conversation summaries.
- **Memory consolidation** — trigger LLM-powered summarization when a session exceeds a configurable message threshold, updating `MEMORY.md` and `HISTORY.md` non-destructively.
- **Semantic / archival memory** — embeddings-powered long-term memory with hybrid vector + full-text search for retrieving relevant past context on demand.

## Tool System

### MCP (Model Context Protocol)

Add a first-class MCP client so Molf workers can connect to external tool servers using the industry-standard protocol.

- **Stdio transport** — spawn local MCP servers (e.g. via `npx` or `uvx`) and register their tools transparently.
- **HTTP / SSE transport** — connect to remote MCP endpoints.
- **Auto-discovery and registration** — tools are registered with namespaced names (`mcp_<server>_<tool>`).
- **Health monitoring** — poll server health and restart on crash with exponential backoff.
- **Compatible with Claude Desktop / Cursor** — use the same config format so existing MCP setups work out of the box.

### Browser Automation

- **Browser tool** — built-in Playwright/Chromium control: navigate, screenshot, click, type, scroll, evaluate JS.
- **Web search tool** — built-in web search (Brave Search API or DuckDuckGo fallback) for the agent to retrieve live information.
- **Web fetch tool** — fetch and extract readable content from URLs with readability-style parsing and SSRF protection.

### Sandboxed Execution

- **Docker/container isolation for `shell_exec`** — run shell commands inside a container so the agent cannot affect the host filesystem or network beyond defined boundaries.
- **Configurable allowlist/denylist** — administrators can define which commands or paths are permitted inside the sandbox.

### Tool Approval

- **Flexible approval rules** — replace the current all-auto-approve stub with a rule engine: per-tool, per-pattern, and per-session approval policies.
- **Server-side approval system** — gate tool calls that modify server state through an approval workflow, not just client-side prompts.

## Scheduling & Automation

- **Cron scheduling** — allow the agent to schedule future runs using standard cron expressions, stored persistently and executed even when no client is connected.
- **Heartbeat service** — periodic agent wakeup (configurable interval) driven by a `HEARTBEAT.md` instruction file, enabling proactive background tasks without user interaction.

## Shell Execution (`!` prefix)

The shell execution alias is implemented (`!` to save to session, `!!` for fire-and-forget). Remaining work:

- **Privacy redaction** — strip API keys, tokens, and other sensitive environment variables from `!` shell command output before displaying (e.g. `env`, `printenv`, `cat .env`).

## Worker

- **Tool output cleanup policy** — delete files older than 7 days from `.molf/tool-output/`, run on worker startup and at an hourly interval.

## Client & TUI

- **Input history persistence** — save and restore TUI input history across restarts (currently in-memory only).
- **Session continuity on worker change** — switching the bound worker should not clear the active session.
- **Select worker by name at startup** — support `--worker <name>` in addition to `--worker <uuid>` when launching the TUI.
- **Key-value store** — a server-side key-value store attachable to workers, clients, and sessions; used as shared state (e.g. persisting the last active session across TUI restarts).

## Showcase

A planned showcase demonstrating Molf's architecture through a real-world example: a **worker whose only job is to spawn other workers**.

The worker has a single skill — `create_worker` — and nothing else. When called, it provisions a new worker process via Docker, Kubernetes, or a cloud provider API (ECS, Cloud Run, Fly.io, etc.), then registers it with the server. The user can immediately select the new worker and start a session on it.

This showcases a key architectural property: workers are composable and can be single-purpose. The system doesn't require every worker to be a general-purpose agent — you can build a hierarchy where one worker manages infrastructure while others do the actual work.

## Worker & Sessions

### Session Portability

A session is currently permanently bound to the worker that created it. The following items decouple that relationship.

- **File registry on the server** — map `filePath → workerId` so the server knows where each file lives.
- **Lazy file pull** — when a session moves to a different worker, the server brokers on-demand file transfers from the original worker.
- **Clear error to the LLM when a source worker is offline** — instead of a generic timeout, report `file unavailable: worker offline` so the agent can adapt.
- **Session portability** — allow a session to continue on a different worker without losing file access.
- **Worker file sync / replication** — strategy for high-availability setups where multiple workers share the same file tree.
- **Direct worker-to-worker file transfer** — P2P file sharing between workers without routing every byte through the server.

## Platform Expansions

### Web UI

- **Browser-based chat interface** — a lightweight web UI served by the existing server, providing the same session/event access as the TUI without a terminal dependency.

### Additional Messaging Channels

The current clients are the terminal TUI and a Telegram bot. Planned additional integrations:

- **Discord** — bot with message intents and streaming edits.
- **Slack** — Socket Mode (no public URL required).
- **WhatsApp** — bridge-based integration.
- **Signal** — via signal-cli.

### Voice

- **Text-to-speech (TTS)** — synthesize agent responses as audio.
- **Speech-to-text (STT)** — transcribe voice messages (Telegram voice notes, mic input).
- **Talk mode** — continuous voice conversation session.

## Developer Experience

### Plugin & Hooks System

- **Lifecycle hooks** — `BeforeToolCall`, `AfterToolCall`, `BeforeCompaction`, `AfterCompaction`, `SessionStart`, `SessionEnd` and more; hooks can inspect, modify, or block the triggering action.
- **Shell hook protocol** — hooks implemented as shell scripts that receive JSON on stdin and emit JSON on stdout, so any language can extend Molf.
- **Hook discovery** — hooks declared in `HOOK.md` files with eligibility metadata (required binaries, environment variables, OS).
- **Circuit breaker** — hooks that fail repeatedly are automatically disabled to prevent cascading failures.
- **Plugin SDK** — a typed package for building and distributing Molf plugins (custom tools, channels, memory backends).

### Observability

- **OpenTelemetry tracing** — instrument the agent loop, tool dispatch, and LLM calls with structured spans.
- **Usage & cost tracking** — track token counts and estimated cost per session and per turn.
- **Structured logging** — consistent log format across server, worker, and clients with configurable verbosity.

## UX & Adoption

The current setup (three terminals, copy-paste tokens, raw YAML) is the biggest adoption barrier. This area is about making Molf usable by anyone, not just developers comfortable with monorepo tooling.

### Installation

Multiple installation paths are planned to meet users where they are: a one-line shell script, a native desktop installer (macOS/Windows/Linux), a Docker Compose file, and one-click cloud deploy buttons (Fly.io, Railway, Render). All paths end at `molf up` — a single command that starts everything together.

### Onboarding

A `molf onboard` guided wizard covers first-run setup: detecting existing API keys, picking a model, writing a config, and generating a stable auth token. `molf status` and `molf doctor` provide ongoing health checks and diagnostics.

### Web Admin Panel

A browser-based management UI served by the existing server. Covers everything that currently requires editing YAML or reading logs by hand:

- **Sessions** — browse, search, rename, delete, fork; jump into any session from the UI.
- **Workers** — connection status, workdir, registered tools.
- **Skills** — list installed skills, enable/disable, install from a path or URL.
- **MCP servers** — add, configure, and toggle MCP tool servers without touching config files; shows which tools each server exposes and their current health.
- **Config** — edit `molf.yaml` in-browser with live validation and hot reload.
- **Logs** — real-time log viewer per component.
- **PWA** — installable on mobile for management on the go.

### Authentication

The single global token is a placeholder. The right replacement is still being designed — leading candidates are QR code pairing (familiar from WhatsApp Web), passkeys / WebAuthn (biometric, no secrets), and one-time pairing codes (works headless). Whatever is chosen, the end-state includes per-client credentials, role-based access levels (admin / user / read-only), and multi-user support with isolated session namespaces.

## See Also

- [Architecture](/reference/architecture) — package graph, message flow, key abstractions
- [Protocol Reference](/reference/protocol) — full tRPC API, event types, core types
- [Worker Overview](/worker/overview) — running a worker, skills, built-in tools
- [Contributing](/reference/contributing) — how to contribute to Molf
