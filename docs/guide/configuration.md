# Configuration

Molf Assistant is configured through CLI flags, environment variables, and a JSONC config file (`config.json`). This page is the unified reference for all configuration options across every component.

## Configuration Sources

Settings are resolved in this priority order (highest wins):

1. **CLI flags** -- `--port 8080`
2. **Environment variables** -- `MOLF_PORT=8080`
3. **JSONC config file** -- `config.json`
4. **Defaults**

## Server Configuration

### JSONC Config File

The server reads configuration from `config.json` in the data directory by default. Pass `--config` to use a different path. The format is JSONC (JSON with comments and trailing commas).

```jsonc
// config.json
{
  "host": "127.0.0.1",
  "port": 7600,
  "dataDir": ".",
  "model": "google/gemini-2.5-flash",

  // TLS
  "noTls": false,
  "tlsCert": "/path/to/cert.pem",
  "tlsKey": "/path/to/key.pem",

  // Providers
  "enabled_providers": ["google", "anthropic"],
  "enable_all_providers": false,

  // Behavior
  "behavior": {
    "temperature": 0.7,
    "contextPruning": true
  },

  // Plugins
  "plugins": [
    "@molf-ai/plugin-cron",
    { "name": "@molf-ai/plugin-mcp", "config": {} }
  ]
}
```

### CLI Flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--config` | `-c` | Path to JSONC config file | -- |
| `--data-dir` | `-d` | Data directory for sessions, logs, auth | `.` |
| `--host` | `-H` | Bind address | `127.0.0.1` |
| `--port` | `-p` | WebSocket port | `7600` |
| `--token` | `-t` | Fixed auth token | (auto-generated) |
| `--no-tls` | -- | Disable TLS | `false` |
| `--tls-cert` | -- | Path to TLS certificate file | (auto-generated) |
| `--tls-key` | -- | Path to TLS private key file | (auto-generated) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_TOKEN` | (random) | Fixed auth token across restarts |
| `MOLF_HOST` | `127.0.0.1` | Bind address |
| `MOLF_PORT` | `7600` | WebSocket port |
| `MOLF_DATA_DIR` | `.` | Data directory |
| `MOLF_DEFAULT_MODEL` | -- | Default model in `provider/model` format |
| `MOLF_ENABLE_ALL_PROVIDERS` | -- | Set to `1` to enable all providers with detected API keys |
| `MOLF_TLS_SAN` | `IP:127.0.0.1,DNS:localhost` | TLS certificate Subject Alternative Names |
| `MODELS_DEV_DISABLE` | -- | Set to `1` to disable models.dev catalog fetch |
| `MOLF_LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warning`, `error` |
| `MOLF_LOG_FILE` | (enabled) | Set to `none` to disable file logging |

## Worker Configuration

Workers are configured via CLI flags and environment variables (no config file).

### CLI Flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--name` | `-n` | Worker name (required) | -- |
| `--workdir` | `-w` | Working directory for tool execution | Current directory |
| `--server-url` | `-s` | Server WebSocket URL | `wss://127.0.0.1:7600` |
| `--token` | `-t` | Auth token | -- |
| `--tls-ca` | -- | Path to CA certificate file | -- |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_SERVER_URL` | `wss://127.0.0.1:7600` | Server WebSocket URL |
| `MOLF_TOKEN` | -- | Auth token |
| `MOLF_TLS_CA` | -- | Path to CA certificate file |
| `MOLF_LOG_LEVEL` | `info` | Log verbosity |
| `MOLF_LOG_FILE` | (enabled) | Set to `none` to disable file logging |

::: warning Default URL uses TLS
The default server URL is `wss://` (TLS enabled). If the server was started with `--no-tls`, use `ws://` instead:
```bash
pnpm dev:worker -- --name my-worker --server-url ws://127.0.0.1:7600
```
:::

## TUI Client Configuration

### CLI Flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--server-url` | `-s` | Server WebSocket URL | `wss://127.0.0.1:7600` |
| `--token` | `-t` | Auth token | -- |
| `--worker-id` | `-w` | Target worker UUID | (auto) |
| `--session-id` | -- | Resume a specific session | (auto) |
| `--tls-ca` | -- | Path to CA certificate file | -- |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_SERVER_URL` | `wss://127.0.0.1:7600` | Server WebSocket URL |
| `MOLF_TOKEN` | -- | Auth token |
| `MOLF_WORKER_ID` | (auto) | Target worker UUID |
| `MOLF_SESSION_ID` | (auto) | Resume session UUID |
| `MOLF_TLS_CA` | -- | Path to CA certificate |

## Telegram Bot Configuration

### CLI Flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--server-url` | `-s` | Server WebSocket URL | `wss://127.0.0.1:7600` |
| `--token` | `-t` | Auth token | -- |
| `--worker-id` | `-w` | Target worker UUID | (auto) |
| `--bot-token` | `-b` | Telegram bot token | -- |
| `--allowed-users` | -- | Comma-separated allowed user IDs or usernames | (all) |
| `--tls-ca` | -- | Path to CA certificate file | -- |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_SERVER_URL` | `wss://127.0.0.1:7600` | Server WebSocket URL |
| `MOLF_TOKEN` | -- | Auth token |
| `MOLF_WORKER_ID` | (auto) | Target worker UUID |
| `TELEGRAM_BOT_TOKEN` | -- | Telegram bot token |
| `TELEGRAM_ALLOWED_USERS` | (all) | Comma-separated allowed user IDs/usernames |
| `MOLF_TLS_CA` | -- | Path to CA certificate |
| `MOLF_LOG_FILE` | (disabled) | Set to file path to enable file logging |

## TLS Configuration

TLS is enabled by default. The server auto-generates a self-signed EC (prime256v1) certificate on first start with TLSv1.3 minimum version and 365-day validity.

### Disabling TLS

For development, disable TLS with:

```bash
pnpm dev:server -- --no-tls
```

Workers and clients must then use `ws://` instead of `wss://` in their server URL.

### Custom Certificates

Provide your own certificate and key:

```bash
pnpm dev:server -- --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

### Subject Alternative Names

The auto-generated certificate includes SANs for `127.0.0.1` and `localhost` by default. Override with:

```bash
MOLF_TLS_SAN="IP:192.168.1.100,DNS:myhost.local" pnpm dev:server
```

### TOFU Trust Model

On first connection, workers and clients probe the server's certificate via a raw TLS handshake (5s timeout) and display the fingerprint for manual approval. Once approved, the certificate is pinned to `~/.molf/known_certs/` and verified on all future connections (`rejectUnauthorized: true`).

The trust resolution priority is: CA file > saved (pinned) cert > TOFU prompt.

### CA Certificate Mode

If you use a proper CA-signed certificate, workers and clients can verify it with:

```bash
pnpm dev:worker -- --name my-worker --tls-ca /path/to/ca.pem
```

## Authentication

See [Authentication](/server/auth) for the full reference.

Summary:

- **Master token** -- auto-generated on first start or fixed via `MOLF_TOKEN`. SHA-256 hash stored in `{dataDir}/secrets.json`.
- **API keys** -- `yk_` prefixed, issued through the pairing flow. Hashes stored in `secrets.json`.
- **Pairing** -- 6-digit codes for interactive device setup. Rate-limited.
- **Credential storage** -- `~/.molf/servers.json` (configurable via `MOLF_CLIENT_DIR`).

## Logging

| Variable | Default | Applies To | Description |
|----------|---------|------------|-------------|
| `MOLF_LOG_LEVEL` | `info` | All processes | Log verbosity: `debug`, `info`, `warning`, `error` |
| `MOLF_LOG_FILE` | Enabled | Server, Worker | Set to `none` to disable file logging |
| `MOLF_LOG_FILE` | Disabled | Telegram | Set to a file path to enable |

Log file locations:

| Process | Location | Rotation |
|---------|----------|----------|
| Server | `{dataDir}/logs/server.log` | 5MB x 5 files |
| Worker | `{workdir}/.molf/logs/worker.log` | 5MB x 5 files |
| Telegram | (disabled by default) | 5MB x 3 files |

See [Logging](/reference/logging) for categories, formats, and troubleshooting.

## Data Directory Layout

### Server (`{dataDir}/`)

```
secrets.json                          # Auth token hash + API keys + provider keys
config.json                           # JSONC server configuration
sessions/{id}.json                    # Session state files
workers/{workerId}/
  worker.json                         # Persisted worker state
  permissions.jsonc                   # Tool approval rules
  workspaces/{workspaceId}/
    workspace.json                    # Workspace config + session list
    cron/jobs.json                    # Cron job definitions
logs/
  server.log                          # JSONL rotating log
```

### Worker (`{workdir}/`)

```
.molf/
  worker.json                         # Worker UUID
  uploads/                            # Uploaded files
  tool-output/                        # Truncated tool output files
  logs/
    worker.log                        # JSONL rotating log
.agents/
  skills/{name}/SKILL.md              # Skill definitions
  agents/{name}.md                    # Agent definitions
.mcp.json                             # MCP server config
AGENTS.md (or CLAUDE.md)              # Root instruction document
```

### User Home (`~/.molf/`)

```
servers.json                          # Server credentials (API key per server URL)
known_certs/                          # Pinned TLS certificates
```

## Provider API Keys

LLM providers can be configured in two ways:
1. **Environment variables** (detected at startup)
2. **Runtime key management** (no restart needed) — use the TUI `/providers` command or the `provider.setKey` oRPC procedure

Environment variables for each provider:

| Variable | Provider |
|----------|----------|
| `GEMINI_API_KEY` | Google Gemini |
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `XAI_API_KEY` | xAI |
| `MISTRAL_API_KEY` | Mistral |
| `GROQ_API_KEY` | Groq |
| `DEEPINFRA_API_KEY` | DeepInfra |
| `CEREBRAS_API_KEY` | Cerebras |
| `COHERE_API_KEY` | Cohere |
| `TOGETHER_AI_API_KEY` | Together AI |
| `PERPLEXITY_API_KEY` | Perplexity |
| `AWS_ACCESS_KEY_ID` | Amazon Bedrock |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google Vertex AI |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |

Runtime-stored keys are written to `{dataDir}/secrets.json` and take effect immediately. Environment variables take precedence over stored keys when both are present.

See [LLM Providers](/server/llm-providers) for model resolution, custom providers, and the models.dev catalog.

## See Also

- [Server Overview](/server/overview) -- server startup and modules
- [LLM Providers](/server/llm-providers) -- provider setup, model resolution
- [Worker Overview](/worker/overview) -- worker identity, reconnection, workdir layout
- [Terminal TUI](/clients/terminal-tui) -- TUI-specific setup
- [Telegram Bot](/clients/telegram) -- Telegram-specific setup
