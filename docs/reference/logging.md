# Logging

Molf uses [LogTape](https://logtape.org/) for structured logging. Each package imports `@logtape/logtape` directly — there is no shared logging wrapper. Server, worker, and Telegram client each call `configure()` at startup; `agent-core` is a library and only uses `getLogger()`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_LOG_LEVEL` | `"info"` | Log verbosity: `"debug"`, `"info"`, `"warning"`, `"error"` |
| `MOLF_LOG_FILE` | *(enabled)* | Set to `"none"` to disable file logging. For Telegram, set to a file path to enable file logging. |

## Sinks per Process

| Process | Console (stdout) | File | Notes |
|---------|-------------------|------|-------|
| Server | Pretty-formatted | `{dataDir}/logs/server.log` (JSONL) | Both enabled by default |
| Worker | Pretty-formatted | `{workdir}/.molf/logs/worker.log` (JSONL) | Both enabled by default |
| Telegram Bot | Pretty-formatted | Only if `MOLF_LOG_FILE` is set to a path | Console always on, file opt-in |
| TUI Client | **None** | Not yet implemented | Ink owns stdout — no console sink |
| Tests | None | None | LogTape no-ops without `configure()` |

::: tip
The TUI client cannot use console sinks because Ink manages stdout directly. Writing log output to stdout would corrupt the terminal UI.
:::

## File Rotation

| Setting | Value |
|---------|-------|
| Format | JSONL (one JSON object per line) |
| Max file size | 5 MB |
| Max files | 5 (server, worker) or 3 (Telegram) |
| Rotation behavior | Oldest file deleted when limit reached |

## Log Categories

| Category | Package | Description |
|----------|---------|-------------|
| `molf.server` | server | Server startup, shutdown, general operations |
| `molf.server.auth` | server | Token generation, verification, failures |
| `molf.server.session` | server | Session create, load, delete, eviction |
| `molf.server.agent` | server | Agent turns, streaming, tool dispatch results |
| `molf.server.event` | server | EventBus pub/sub operations |
| `molf.server.approval` | server | Tool approval gate — rule evaluation, pending requests, approvals/denials, cascade resolution |
| `molf.server.dispatch` | server | Tool call routing and timeouts |
| `molf.providers.catalog` | agent-core | models.dev catalog fetch, cache read/write, refresh |
| `molf.providers.registry` | agent-core | Provider initialization pipeline, env key detection, allowed providers |
| `molf.providers.sdk` | agent-core | AI SDK instance creation, language model caching |
| `molf.agent` | agent-core | LLM streaming metadata, context pruning, doom loops |
| `molf.worker` | worker | Worker startup, skill loading, shutdown |
| `molf.worker.mcp` | worker | MCP server connections, tool reloading |
| `molf.worker.conn` | worker | Connection state, reconnection attempts |
| `molf.worker.tool` | worker | Tool execution details |
| `molf.telegram` | client-telegram | Bot startup, message handling |
| `molf.telegram.stream` | client-telegram | Streaming responses |

## Log Levels

| Level | What It Shows | Default Visible? |
|-------|---------------|------------------|
| `error` | Failures requiring attention — connection failures, corrupt data, auth rejections | Yes |
| `warning` | Unexpected but recovered — token mismatch, MCP reload failure, tool limit exceeded | Yes |
| `info` | Operational milestones — startup, connections, resource loading, shutdown | Yes |
| `debug` | Detailed diagnostics — tool calls, MCP state transitions, per-request details | No |

## Reading Log Files

```bash
# Follow server logs (pretty JSON)
tail -f data/logs/server.log | jq '.'

# Follow worker logs
tail -f .molf/logs/worker.log | jq '.'

# Find errors
grep '"error"' data/logs/server.log | jq '.'

# Filter by category
grep 'molf.worker.mcp' .molf/logs/worker.log | jq '.'
```

## Usage Examples

```bash
# Default (info level, file logging enabled)
GEMINI_API_KEY=<key> bun run dev:server

# Debug logging for server
MOLF_LOG_LEVEL=debug GEMINI_API_KEY=<key> bun run dev:server

# Worker with debug logging and no file output
MOLF_LOG_LEVEL=debug MOLF_LOG_FILE=none bun run dev:worker -- --name my-worker --token <token>

# Telegram with file logging
MOLF_LOG_FILE=/var/log/molf-telegram.log bun run dev:client-telegram -- --token <token> --bot-token <bot-token>
```

## Adding Logs

To add logging to new code, import `getLogger` and use structured metadata:

```typescript
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["molf", "component"]);

// Structured metadata, not string interpolation
logger.info("Resource loaded", { count: items.length });
logger.error("Operation failed", { error: err, operationId });
```

**Key rules:**

- Use structured metadata (objects), not string interpolation
- Don't log in hot paths (per-token streaming loops)
- `info` for milestones, `debug` for details, `error` for failures
- `agent-core` never calls `configure()` -- only the host process does

::: info
LogTape silently no-ops when `configure()` has not been called. This means `agent-core` can call `getLogger()` freely and logging will only activate when the host process (server, worker, etc.) sets up sinks at startup.
:::

## See Also

- [Configuration](/guide/configuration) — environment variables reference
- [Server Overview](/server/overview) — running the server, auth tokens, LLM providers
- [Worker Overview](/worker/overview) — running a worker, identity, reconnection
- [Troubleshooting](/reference/troubleshooting) — common issues and fixes
- [Contributing](/reference/contributing) — design principles and development guides
