# Server Overview

The server is the central coordinator in Molf Assistant. It orchestrates LLM interactions, manages sessions and workspaces, dispatches tool calls to workers, and routes events to clients. The server does not execute tools -- that is the worker's responsibility.

## Starting the Server

```bash
pnpm dev:server
```

Or run the entry point directly:

```bash
tsx packages/server/src/main.ts
```

The server reads `molf.yaml` from the current directory by default. See [Configuration](/guide/configuration) for all CLI flags, environment variables, and YAML options.

## Startup Sequence

On start, the server initializes these components in order:

1. **Auth system** -- loads or creates the master token, initializes API key store
2. **Provider registry** -- detects available LLM providers via API key environment variables
3. **SessionManager** -- loads persisted sessions from disk
4. **WorkerStore** -- loads persisted worker state
5. **ConnectionRegistry** -- tracks connected workers and clients
6. **EventBus** -- per-session event channels for streaming to clients
7. **ToolDispatch** -- promise queue for routing tool calls to workers (120s timeout)
8. **UploadDispatch** -- file upload routing (30s timeout)
9. **FsDispatch** -- filesystem read routing (30s timeout)
10. **InlineMediaCache** -- caches media for LLM context (8h TTL, 200MB max)
11. **WorkspaceStore** -- workspace configuration and session grouping
12. **WorkspaceNotifier** -- pushes workspace events to subscribed clients
13. **ApprovalGate** -- tool approval evaluation engine
14. **PluginLoader** -- loads and initializes server plugins
15. **AgentRunner** -- LLM orchestration engine
16. **PairingStore** -- manages pairing codes for new device setup
17. **RateLimiter** -- rate limiting for public procedures

## TLS

TLS is enabled by default. On first start, the server generates a self-signed EC (prime256v1) certificate with TLSv1.3 minimum version and 365-day validity.

Workers and clients verify the certificate using TOFU (trust-on-first-use): the fingerprint is displayed on first connection for manual approval, then pinned for future use.

| Option | Description |
|--------|-------------|
| `--no-tls` | Disable TLS entirely |
| `--tls-cert` / `--tls-key` | Use custom certificate and key files |
| `MOLF_TLS_SAN` | Subject Alternative Names (default: `IP:127.0.0.1,DNS:localhost`) |

See [Configuration > TLS](/guide/configuration#tls-configuration) for full details.

## Authentication

The server supports two authentication mechanisms:

- **Master token** -- generated on first start (or set via `MOLF_TOKEN`), SHA-256 hash stored in `{dataDir}/server.json`
- **API keys** -- `yk_` prefixed keys issued through the pairing flow, hashes stored in `server.json`

All authenticated tRPC procedures verify credentials via constant-time comparison of the `Authorization: Bearer` header against stored hashes.

See [Authentication](/server/auth) for the full auth flow, pairing codes, and API key management.

## Workspaces

Workspaces group sessions and carry per-workspace configuration. Each workspace can override the default LLM model.

- A default workspace is auto-created on first use
- Configuration stored at `{dataDir}/workers/{workerId}/workspaces/{workspaceId}/workspace.json`
- Managed via the `workspace.*` tRPC procedures

## Plugin System

Two plugins are loaded by default:

- **`@molf-ai/plugin-cron`** -- scheduled task execution with `at`, `every`, and `cron` schedule types
- **`@molf-ai/plugin-mcp`** -- MCP client integration for workers

Configure plugins in `molf.yaml`:

```yaml
plugins:
  - "@molf-ai/plugin-cron"
  - name: "@molf-ai/plugin-mcp"
    config: {}
```

Server plugins can add tRPC routes, tools, session-scoped tools, services, and hook handlers. Worker plugin specifiers are sent to workers on connect so they can load their worker-side counterparts.

See [Plugins](/reference/plugins) for the full plugin API and hook reference.

## WebSocket Settings

| Setting | Value |
|---------|-------|
| Max payload | 50MB |
| Keep-alive ping interval | 30s |
| Pong timeout | 10s |

## Key Timeouts

| Operation | Timeout |
|-----------|---------|
| Tool dispatch | 120s |
| Upload dispatch | 30s |
| FS read dispatch | 30s |
| Agent turn | 30 min |
| Agent idle eviction | 30 min |
| Subagent execution | 5 min |

## tRPC Routers

The server exposes 9 tRPC sub-routers over WebSocket:

| Router | Purpose |
|--------|---------|
| `session.*` | Create, list, load, delete, rename sessions |
| `agent.*` | Prompt, abort, status, event subscription |
| `tool.*` | List tools, approve/deny tool calls |
| `worker.*` | Worker registration, state sync, tool dispatch |
| `fs.*` | Filesystem read operations |
| `provider.*` | List providers and models |
| `workspace.*` | Workspace management |
| `auth.*` | Pairing codes, API key management |
| `plugin.*` | Plugin route dispatch |

See [Protocol](/reference/protocol) for the full API reference.

## See Also

- [Sessions](/server/sessions) -- session lifecycle, summarization, context pruning
- [LLM Providers](/server/llm-providers) -- provider setup, model resolution
- [Authentication](/server/auth) -- auth flow, pairing, API keys
- [Event System](/server/events) -- event types, EventBus, subscriptions
- [Architecture](/reference/architecture) -- package dependency graph and module structure
