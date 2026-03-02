# Configuration

This page is the unified configuration reference for all Molf components. Each component can be configured through some combination of YAML config files, CLI flags, and environment variables.

## Server Configuration

### YAML Config File

The server reads configuration from `molf.yaml` in the current directory by default. Pass `--config` to use a different path.

```yaml
# molf.yaml
host: "127.0.0.1"
port: 7600
dataDir: "."
model: "google/gemini-3-flash-preview"    # "provider/model" combined format
enabled_providers:                         # Optional: limit available providers
  - google
  - anthropic
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | `"127.0.0.1"` | Address the server binds to |
| `port` | number | `7600` | WebSocket port |
| `dataDir` | string | `"."` | Directory for session files and `server.json` (auth token hash) |
| `model` | string | *(required)* | Default model in `"provider/model"` format (e.g. `"anthropic/claude-sonnet-4-20250514"`) |
| `enabled_providers` | string[] | *(auto)* | List of additional provider IDs to enable beyond the default model's provider |
| `enable_all_providers` | boolean | `false` | Enable all providers with detected API keys |
| `providers` | object | — | Custom provider definitions. See [Providers](/server/providers) for the full format. |

Per-worker tool approval rules are stored in `{dataDir}/workers/{workerId}/permissions.jsonc` and can be edited manually or updated automatically when users select "Always Approve." See [Tool Approval](/server/tool-approval) for the full rules reference and file format.

### CLI Flags

CLI flags override values from the YAML config file.

```bash
bun run dev:server -- --config molf.yaml --host 0.0.0.0 --port 8080 --token my-secret
```

| Flag | Short | Env Var | Default | Description |
|------|-------|---------|---------|-------------|
| `--config` | `-c` | — | `./molf.yaml` | Path to config file |
| `--data-dir` | `-d` | `MOLF_DATA_DIR` | `.` | Data directory path |
| `--host` | `-H` | `MOLF_HOST` | `127.0.0.1` | Bind address |
| `--port` | `-p` | `MOLF_PORT` | `7600` | WebSocket port |
| `--token` | `-t` | `MOLF_TOKEN` | *(random)* | Fixed auth token (skips random generation) |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `MOLF_TOKEN` | Fixed auth token — equivalent to `--token` (skips random generation) |
| `MOLF_HOST` | Bind address — equivalent to `--host` |
| `MOLF_PORT` | WebSocket port — equivalent to `--port` |
| `MOLF_DATA_DIR` | Data directory — equivalent to `--data-dir` |
| `MOLF_DEFAULT_MODEL` | Override default model (e.g. `"anthropic/claude-sonnet-4-20250514"`) |
| `MOLF_ENABLE_ALL_PROVIDERS` | Set to `1` to enable all providers with detected API keys |
| `MODELS_DEV_DISABLE` | Set to `1` to disable fetching model catalog from models.dev |
| `GEMINI_API_KEY` | API key for the Google Gemini provider |
| `ANTHROPIC_API_KEY` | API key for the Anthropic provider |
| `OPENAI_API_KEY` | API key for the OpenAI provider. See [Providers](/server/providers) for all auto-detected API key env vars. |
| `MOLF_LOG_LEVEL` | Log verbosity: `"debug"`, `"info"` (default), `"warning"`, `"error"` |
| `MOLF_LOG_FILE` | Set to `"none"` to disable file logging (default: enabled) |

**Priority order:** CLI flags > environment variables > YAML config > built-in defaults.

### LLM Providers

Molf supports 16+ LLM providers out of the box. The server auto-detects available providers by scanning for API key environment variables at startup.

Set the appropriate API key and specify the model in `"provider/model"` format:

```yaml
model: "anthropic/claude-sonnet-4-20250514"
```

```bash
ANTHROPIC_API_KEY=<key> bun run dev:server
```

See [Providers](/server/providers) for the complete list of bundled providers, model switching, and custom provider configuration.

## Worker Configuration

Workers are configured via CLI flags only (no YAML config).

### CLI Flags

```bash
bun run dev:worker -- --name my-worker --token <token> [options]
```

| Flag | Short | Env Var | Default | Required |
|------|-------|---------|---------|----------|
| `--name` | `-n` | — | — | Yes |
| `--token` | `-t` | `MOLF_TOKEN` | — | Yes |
| `--server-url` | `-s` | `MOLF_SERVER_URL` | `ws://127.0.0.1:7600` | No |
| `--workdir` | `-w` | — | current directory | No |

### MCP Server Configuration

Workers load MCP server configurations from `.mcp.json` in the worker's
working directory. This file is optional — if absent, no MCP servers are loaded.

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": {}
    },
    "remote": {
      "type": "http",
      "url": "https://my-mcp-service.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MY_TOKEN}"
      }
    }
  }
}
```

Environment variables in config strings are interpolated using `${VAR_NAME}`
syntax. The special variable `${WORKDIR}` resolves to the worker's working
directory.

See [MCP Integration](/worker/mcp) for the full schema reference, transport
details, and examples.

## TUI Client Configuration

### CLI Flags

```bash
bun run dev:client-tui -- --token <token> [options]
```

| Flag | Short | Env Var | Default |
|------|-------|---------|---------|
| `--server-url` | `-s` | `MOLF_SERVER_URL` | `ws://127.0.0.1:7600` |
| `--token` | `-t` | `MOLF_TOKEN` | *(required)* |
| `--worker-id` | `-w` | `MOLF_WORKER_ID` | *(auto-selects first)* |
| `--session-id` | — | `MOLF_SESSION_ID` | *(creates or resumes most recent)* |

### Environment Variables

The TUI reads all its configuration from environment variables when CLI flags are not provided:

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_TOKEN` | *(required)* | Auth token from the server |
| `MOLF_SERVER_URL` | `ws://127.0.0.1:7600` | Server WebSocket URL |
| `MOLF_WORKER_ID` | *(auto-selects first)* | Target worker UUID for new sessions |
| `MOLF_SESSION_ID` | *(creates new)* | Resume an existing session by UUID |

Example — resume a specific session:

```bash
MOLF_TOKEN=my-secret MOLF_SESSION_ID=<uuid> bun run dev:client-tui
```

## Telegram Bot Configuration

### YAML Config

The Telegram bot reads its configuration from the `telegram` section of `molf.yaml`:

```yaml
telegram:
  botToken: "123456:ABC-DEF..."
  allowedUsers:
    - "@username"
    - "12345678"
  ackReaction: "eyes"          # Emoji reaction on message receipt
  streamingThrottleMs: 300     # Throttle for edit-in-place streaming (ms)
```

| Field | Default | Description |
|-------|---------|-------------|
| `botToken` | *(required)* | Telegram bot token from @BotFather |
| `allowedUsers` | *(empty — allow all)* | User IDs (numeric) or usernames (`@name`) allowed to interact |
| `ackReaction` | `"eyes"` | Emoji reaction sent on message receipt |
| `streamingThrottleMs` | `300` | Minimum interval between message edits during streaming |

### CLI Flags

```bash
bun run dev:client-telegram -- --token <server-token> --bot-token <telegram-token> [options]
```

| Flag | Short | Env Var | Default |
|------|-------|---------|---------|
| `--server-url` | `-s` | `MOLF_SERVER_URL` | `ws://127.0.0.1:7600` |
| `--token` | `-t` | `MOLF_TOKEN` | *(required)* |
| `--worker-id` | `-w` | `MOLF_WORKER_ID` | *(auto-selects first)* |
| `--bot-token` | `-b` | `TELEGRAM_BOT_TOKEN` | *(required)* |
| `--allowed-users` | — | `TELEGRAM_ALLOWED_USERS` | *(empty — allow all)* |
| `--config` | `-c` | — | — |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `MOLF_LOG_LEVEL` | Log verbosity (same as server) |
| `MOLF_LOG_FILE` | Set to a file path to enable file logging (default: console only) |

### Priority

The Telegram client resolves configuration in this order (highest wins):

**Environment variables > CLI flags > YAML config**

## Logging

All Molf processes use [LogTape](https://logtape.org/) for structured logging, controlled via environment variables.

| Variable | Default | Applies To | Description |
|----------|---------|------------|-------------|
| `MOLF_LOG_LEVEL` | `"info"` | All processes | Log verbosity: `"debug"`, `"info"`, `"warning"`, `"error"` |
| `MOLF_LOG_FILE` | Enabled | Server, Worker | Set to `"none"` to disable file logging |
| `MOLF_LOG_FILE` | Disabled | Telegram | Set to a file path to enable file logging |

### Log File Locations

| Process | Default Location | Format |
|---------|-----------------|--------|
| Server | `{dataDir}/logs/server.log` | JSONL |
| Worker | `{workdir}/.molf/logs/worker.log` | JSONL |
| TUI | *(none)* | — |
| Telegram | *(none unless `MOLF_LOG_FILE` set)* | JSONL |

Files are rotated at 5 MB, keeping the 5 most recent files (3 for Telegram).

See [Logging Reference](/reference/logging) for categories, levels, and troubleshooting with logs.

## See Also

- [Server Overview](/server/overview) — auth tokens and server modules
- [Providers](/server/providers) — LLM providers, model switching, custom providers
- [Worker Overview](/worker/overview) — worker identity, reconnection, and workdir layout
- [Terminal TUI](/clients/terminal-tui) — TUI-specific setup and slash commands
- [Telegram Bot](/clients/telegram) — Telegram-specific setup and bot commands
