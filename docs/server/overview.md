# Server Overview

## What the Server Does

The server is the central hub of a Molf deployment. It is a tRPC WebSocket server that coordinates everything between clients and workers:

- **LLM interaction** — sends prompts to the configured LLM provider (Gemini or Anthropic) via the Vercel AI SDK and streams responses back
- **Session management** — creates, lists, loads, deletes, and renames sessions, persisting them as JSON files on disk
- **Tool dispatch** — routes tool calls from the LLM to the appropriate worker and returns results
- **Event streaming** — broadcasts agent events (content deltas, tool call progress, errors) to subscribed clients in real time
- **File uploads** — forwards file uploads from clients to workers for storage

Clients and workers both connect **to** the server — they never communicate with each other directly. Multiple clients and multiple workers can be connected simultaneously.

## Running the Server

```bash
GEMINI_API_KEY=<your-key> bun run dev:server
```

The server reads configuration from `molf.yaml` in the current directory by default. See [Configuration](/guide/configuration) for the full YAML reference.

### CLI Flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--config` | `-c` | `./molf.yaml` | Path to YAML config file |
| `--data-dir` | `-d` | `.` | Data directory for sessions and auth |
| `--host` | `-H` | `127.0.0.1` | Address to bind to |
| `--port` | `-p` | `7600` | WebSocket port |

Example with custom host and port:

```bash
GEMINI_API_KEY=<key> bun run dev:server -- --host 0.0.0.0 --port 8080
```

## Auth Token

The server uses a token-based authentication system. Every client and worker must present a valid token to connect.

**How it works:**

1. On startup, the server checks for a `MOLF_TOKEN` environment variable
2. If set, that value becomes the auth token. If not, the server generates a random 32-byte hex token
3. The SHA-256 hash of the token is stored in `{dataDir}/server.json` — the token itself is never written to disk
4. The token is printed to stdout so you can pass it to clients and workers
5. Clients and workers include the token as a URL query parameter when connecting: `ws://host:port?token=<token>`
6. The `authedProcedure` middleware hashes incoming tokens and compares against the stored hash

::: tip Fixed token
Set `MOLF_TOKEN` to keep the same token across server restarts. Without it, a new random token is generated each time.

```bash
MOLF_TOKEN=my-secret-token bun run dev:server
```
:::

## Logging

The server writes structured logs to both the console and a rotating log file.

| Sink | Output | Format |
|------|--------|--------|
| Console | stdout | Pretty-formatted (timestamp, category, message, properties) |
| File | `{dataDir}/logs/server.log` | JSONL (one JSON object per line) |

Control logging via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_LOG_LEVEL` | `"info"` | `"debug"`, `"info"`, `"warning"`, `"error"` |
| `MOLF_LOG_FILE` | Enabled | Set to `"none"` to disable file logging |

```bash
# Debug logging
MOLF_LOG_LEVEL=debug GEMINI_API_KEY=<key> bun run dev:server
```

At the default `info` level, the server logs startup, auth token generation, session operations, and worker connections. Set to `debug` for tool dispatch details and per-request diagnostics.

See [Logging Reference](/reference/logging) for the full category list and log file format.

## LLM Providers

Molf currently ships with two built-in LLM providers. Configure the provider and model in `molf.yaml` or override them with environment variables (`MOLF_LLM_PROVIDER`, `MOLF_LLM_MODEL`). Additional providers (OpenAI, DeepSeek, OpenRouter, Ollama, OAuth-based subscription auth, and more) are planned — see [Roadmap](/reference/roadmap#model--provider-expansions).

**Gemini** — set `GEMINI_API_KEY`:

| Model | Context Window |
|-------|----------------|
| `gemini-2.5-pro-preview-05-06` | 1M tokens |
| `gemini-2.5-flash-preview-04-17` | 1M tokens |
| `gemini-2.0-flash` | 1M tokens |
| `gemini-2.0-flash-lite` | 1M tokens |
| `gemini-1.5-pro` | 2M tokens |
| `gemini-1.5-flash` | 1M tokens |

**Anthropic** — set `ANTHROPIC_API_KEY`:

| Model | Context Window |
|-------|----------------|
| `claude-sonnet-4-5-20250929` | 200K tokens |
| `claude-haiku-4-5-20251001` | 200K tokens |
| `claude-opus-4-6` | 200K tokens |
| `claude-3-5-sonnet-20241022` | 200K tokens |
| `claude-3-5-haiku-20241022` | 200K tokens |

Individual sessions can override the server-wide LLM settings by passing a `config.llm` object when creating a session. This lets different sessions use different models or providers.

## Server Modules

The server is composed of focused modules, each handling a single concern:

| Module | Responsibility |
|--------|----------------|
| **main** | Entry point — parses CLI args, loads config, starts server, prints token, handles signals |
| **server** | Creates WebSocket server, initializes all components, manages connection lifecycle |
| **config** | Loads `molf.yaml`, parses CLI flags |
| **auth** | Token generation, SHA-256 hashing, and verification |
| **context** | Defines tRPC context and the `authedProcedure` middleware |
| **router** | Complete tRPC router with `session`, `agent`, `tool`, and `worker` sub-routers |
| **session-mgr** | In-memory session cache with disk persistence |
| **event-bus** | Per-session pub/sub for streaming events to clients |
| **agent-runner** | Manages Agent instances per session — builds tools, runs prompts, persists messages, automatic context summarization, and tool enhancement hooks |
| **tool-enhancements** | Server-side hooks for tool execution (beforeExecute/afterExecute); currently handles nested instruction injection on `read_file` |
| **tool-dispatch** | Promise-based routing of tool calls to workers (120s default timeout) |
| **worker-dispatch** | Generic server-to-worker request/response dispatch pattern |
| **upload-dispatch** | Routes file uploads from clients to workers |
| **fs-dispatch** | Routes filesystem read requests to workers (for retrieving truncated tool output) |
| **connection-registry** | Tracks all connected workers (tools, skills, metadata) and clients |
| **inline-media-cache** | In-memory cache for image bytes enabling re-inlining on session resume (8h TTL, 200MB max) |

For a deeper look at how these modules interact, see [Architecture](/reference/architecture).

## See Also

- [Sessions](/server/sessions) — session lifecycle, persistence format, per-session configuration
- [Configuration](/guide/configuration) — full YAML config reference and CLI flags
- [Architecture](/reference/architecture) — package dependency graph and message flow diagrams
