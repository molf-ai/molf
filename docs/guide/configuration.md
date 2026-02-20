# Configuration

This page is the unified configuration reference for all Molf components. Each component can be configured through some combination of YAML config files, CLI flags, and environment variables.

## Server Configuration

### YAML Config File

The server reads configuration from `molf.yaml` in the current directory by default. Pass `--config` to use a different path.

```yaml
# molf.yaml
host: "127.0.0.1"           # Bind address
port: 7600                   # WebSocket port
dataDir: "."                 # Data directory for sessions and auth
llm:
  provider: "gemini"         # LLM provider name
  model: "gemini-2.0-flash"  # Model name
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | `"127.0.0.1"` | Address the server binds to |
| `port` | number | `7600` | WebSocket port |
| `dataDir` | string | `"."` | Directory for session files and `server.json` (auth token hash) |
| `llm.provider` | string | *(required)* | LLM provider: `"gemini"` or `"anthropic"` |
| `llm.model` | string | *(required)* | Model identifier (e.g. `"gemini-2.0-flash"`) |

### CLI Flags

CLI flags override values from the YAML config file.

```bash
bun run dev:server -- --config molf.yaml --host 0.0.0.0 --port 8080
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--config` | `-c` | `./molf.yaml` | Path to config file |
| `--data-dir` | `-d` | `.` | Data directory path |
| `--host` | `-H` | `127.0.0.1` | Bind address |
| `--port` | `-p` | `7600` | WebSocket port |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `MOLF_TOKEN` | Fixed auth token (skips random generation on each startup) |
| `MOLF_LLM_PROVIDER` | Override LLM provider (takes precedence over YAML) |
| `MOLF_LLM_MODEL` | Override LLM model (takes precedence over YAML) |
| `GEMINI_API_KEY` | API key for the Gemini provider |
| `ANTHROPIC_API_KEY` | API key for the Anthropic provider |

**Priority order:** CLI flags > environment variables > YAML config > built-in defaults.

### LLM Providers

Molf supports two LLM providers out of the box. Set the appropriate API key as an environment variable and configure the provider and model in your YAML config or via `MOLF_LLM_PROVIDER` / `MOLF_LLM_MODEL`.

**Gemini** (`GEMINI_API_KEY`):

| Model | Context Window |
|-------|----------------|
| `gemini-2.5-pro-preview-05-06` | 1M tokens |
| `gemini-2.5-flash-preview-04-17` | 1M tokens |
| `gemini-2.0-flash` | 1M tokens |
| `gemini-2.0-flash-lite` | 1M tokens |
| `gemini-1.5-pro` | 2M tokens |
| `gemini-1.5-flash` | 1M tokens |

**Anthropic** (`ANTHROPIC_API_KEY`):

| Model | Context Window |
|-------|----------------|
| `claude-sonnet-4-5-20250929` | 200K tokens |
| `claude-haiku-4-5-20251001` | 200K tokens |
| `claude-opus-4-6` | 200K tokens |
| `claude-3-5-sonnet-20241022` | 200K tokens |
| `claude-3-5-haiku-20241022` | 200K tokens |

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

### Priority

The Telegram client resolves configuration in this order (highest wins):

**Environment variables > CLI flags > YAML config**

## See Also

- [Server Overview](/server/overview) — auth tokens, LLM providers, and server modules
- [Worker Overview](/worker/overview) — worker identity, reconnection, and workdir layout
- [Terminal TUI](/clients/terminal-tui) — TUI-specific setup and slash commands
- [Telegram Bot](/clients/telegram) — Telegram-specific setup and bot commands
