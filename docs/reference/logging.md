# Logging

Molf Assistant uses [LogTape](https://logtape.org/) for structured logging. Each process (server, worker, Telegram client) calls `configure()` at startup to set up sinks. The `agent-core` package is a library and only uses `getLogger()` -- it never calls `configure()`.

## Configuration

Two environment variables control logging behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_LOG_LEVEL` | `info` | Log verbosity. One of: `debug`, `info`, `warning`, `error` |
| `MOLF_LOG_FILE` | (enabled) | Set to `none` to disable file logging |

These variables are read by each process at startup.

## Log Locations

| Process | File Path | Format | Rotation |
|---------|-----------|--------|----------|
| Server | `{dataDir}/logs/server.log` | JSONL | 5 MB max, 5 files |
| Worker | `{workdir}/.molf/logs/worker.log` | JSONL | 5 MB max, 5 files |
| Telegram client | configured via `MOLF_LOG_FILE` | JSONL | 5 MB max, 3 files |

All log files use JSON Lines format (one JSON object per line) for machine parsing. The rotating file sink is provided by `@logtape/file`.

## Sinks

Each process configures two sinks:

### Console Sink

Human-readable output using `@logtape/pretty` formatter with:
- RFC 3339 timestamps
- Category width: 18 characters
- Properties included
- No word wrap

### File Sink

Machine-readable JSONL output using LogTape's `jsonLinesFormatter`. The file sink is created by `getRotatingFileSink` with size-based rotation.

To disable the file sink, set `MOLF_LOG_FILE=none`.

## Log Categories

LogTape uses hierarchical categories. All Molf logs fall under the `molf` root category. The `logtape.meta` category is set to `warning` level to suppress internal LogTape noise.

```
molf
  ├── server
  ├── agent-core
  ├── worker
  ├── client-telegram
  ├── plugin-cron
  └── plugin-mcp
```

Each module typically creates a logger scoped to its component, such as `getLogger(["molf", "server", "agent-runner"])`.

## Usage in Code

### In packages that configure logging (server, worker, clients)

```typescript
import { configure, getConsoleSink, jsonLinesFormatter } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { getRotatingFileSink } from "@logtape/file";

const logLevel = (process.env.MOLF_LOG_LEVEL ?? "info") as "debug" | "info" | "warning" | "error";

await configure({
  sinks: {
    console: getConsoleSink({ formatter: getPrettyFormatter({ ... }) }),
    file: getRotatingFileSink("path/to/log.log", {
      formatter: jsonLinesFormatter,
      maxSize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
  },
  loggers: [
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console", "file"] },
    { category: ["molf"], lowestLevel: logLevel, sinks: ["console", "file"] },
  ],
});
```

### In library packages (agent-core)

```typescript
import { getLogger } from "@logtape/logtape";

const log = getLogger(["molf", "agent-core", "agent"]);

log.info("Starting agent turn", { sessionId, model });
log.debug("Tool call received", { toolName, args });
log.warn("Doom loop detected", { toolName, count: 3 });
log.error("Agent turn failed", { error: err.message });
```

## Debugging Tips

- Set `MOLF_LOG_LEVEL=debug` to see all log output, including tool call arguments, LLM request/response details, and plugin hook dispatches.
- Log files are JSONL, so you can use `jq` to filter and format:
  ```bash
  # Show errors only
  cat data/logs/server.log | jq 'select(.level == "error")'

  # Follow logs for a specific session
  tail -f data/logs/server.log | jq 'select(.properties.sessionId == "your-session-id")'
  ```
- If file logging is consuming too much disk space, either set `MOLF_LOG_FILE=none` or adjust the rotation settings in the source.

## See also

- [Troubleshooting](./troubleshooting.md) -- using logs to diagnose issues
- [Contributing](./contributing.md) -- development setup
