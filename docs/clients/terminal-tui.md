# Terminal TUI

The terminal TUI is an interactive chat client built with Ink 5 and React 18 that connects to the Molf server over WebSocket, providing streaming responses, tool approval, session and workspace management, and slash commands directly in your terminal.

## Starting the TUI

```bash
pnpm dev:client-tui
```

On first run, the TUI walks through two setup steps:

1. **TLS fingerprint approval** -- the server uses a self-signed TLS certificate by default. The TUI probes the certificate, displays its fingerprint, and asks you to confirm trust. The approved certificate is pinned to `~/.molf/known_certs/` for future connections.
2. **Pairing** -- if no auth token is available (via `--token`, `MOLF_TOKEN`, or saved credentials in `~/.molf/credentials.json`), the TUI runs an interactive pairing flow that exchanges a 6-digit code for an API key.

After setup, the Ink-based UI renders with a header, chat history, input area, and slash command autocomplete.

## CLI Flags

| Flag | Short | Env Var | Default | Description |
|------|-------|---------|---------|-------------|
| `--server-url` | `-s` | `MOLF_SERVER_URL` | `wss://127.0.0.1:7600` | WebSocket server URL |
| `--token` | `-t` | `MOLF_TOKEN` | -- | Auth token or API key |
| `--worker-id` | `-w` | `MOLF_WORKER_ID` | (auto-select first online worker) | Target worker UUID |
| `--session-id` | -- | `MOLF_SESSION_ID` | (last session or new) | Resume an existing session by ID |
| `--tls-ca` | -- | `MOLF_TLS_CA` | -- | Path to a trusted CA certificate PEM file |

If `--worker-id` is omitted, the TUI selects the first connected worker automatically. If `--session-id` is omitted, it loads the last session from the default workspace or creates a new one.

## Connection

The TUI connects to `wss://127.0.0.1:7600` by default (TLS). Authentication uses a `Bearer` token sent as a WebSocket header.

Token resolution order:

1. `--token` flag or `MOLF_TOKEN` env var
2. Saved API key from `~/.molf/credentials.json` (matched by server URL)
3. Interactive pairing flow (exchanges a 6-digit code for a new `yk_`-prefixed API key)

The WebSocket client reconnects automatically with exponential backoff (1 s initial, 30 s max, 2x multiplier, +/-25% jitter).

A warning is displayed when connecting to a remote server (not `localhost` / `127.0.0.1` / `::1`) using a master token instead of a paired API key. The pinned certificate's expiry is also checked -- a warning appears if the certificate has expired or will expire within 30 days.

## Slash Commands

Type `/` to enter command mode. An autocomplete popup appears with matching commands. Use Up/Down arrows to navigate and Tab to accept a completion.

| Command | Aliases | Description |
|---------|---------|-------------|
| `/clear` | `/new`, `/reset` | Start a new session (the old session is preserved on disk) |
| `/exit` | `/quit`, `/q` | Exit the TUI |
| `/help` | `/commands` | Show all available commands |
| `/sessions` | `/resume` | Browse and switch sessions |
| `/rename` | -- | Rename the current session (`/rename <name>`) |
| `/worker` | `/workers`, `/w` | List and switch between workers |
| `/model` | `/m` | List and switch between models (per-workspace) |
| `/workspace` | `/ws` | Browse and manage workspaces (`/workspace new "name"`, `/workspace rename "name"`) |
| `/pair` | -- | Create a pairing code for a new device (`/pair <device-name>`) |
| `/keys` | -- | List and revoke API keys |
| `/editor` | `/edit`, `/e` | Open `$EDITOR` to compose a message |

## Shell Shortcuts

Run shell commands directly on the worker, bypassing the LLM:

| Prefix | Behavior |
|--------|----------|
| `!<command>` | Execute and save the output to session context (the LLM sees it on subsequent turns) |
| `!!<command>` | Execute fire-and-forget (output shown locally, not saved to context) |

Examples:

```
!ls -la          # saved to context
!!git status     # fire-and-forget
```

The `!` prefix requires the agent to be idle. If the agent is busy, use `!!` instead. Both dispatch via the `agent.shellExec` tRPC procedure.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message or execute slash command |
| `Escape` | Abort running agent if busy, or exit if idle |
| `Ctrl+C` | Exit immediately |
| `Ctrl+L` | Clear screen and start a new session |
| `Ctrl+G` | Open external editor to compose a message |
| `Tab` | Accept autocomplete suggestion |
| `Up/Down` | Navigate autocomplete, or scroll through input history |

## Tool Approval

When the LLM requests a tool call that requires user permission, the TUI displays an inline approval prompt showing the tool name and its arguments. The input bar is disabled until the approval is resolved.

| Key | Action |
|-----|--------|
| `Y` | Approve this single tool call |
| `A` | Always approve matching tool+pattern calls (persisted to `permissions.jsonc`) |
| `N` | Deny -- opens a feedback text input where you can type an optional reason, then press Enter |

When multiple approvals are pending, a `[1/N]` counter shows your position in the queue.

If the TUI disconnects and reconnects, any pending approval prompts are automatically replayed by the server.

See [Tool Approval](../server/tool-approval.md) for how rules are evaluated.

## Pickers

Several commands open full-screen interactive pickers:

- **Workspace picker** (`/workspace`) -- browse workspaces and their sessions, create or rename workspaces, select a session to switch to
- **Session picker** (`/sessions`) -- browse and switch between sessions
- **Worker picker** (`/worker`) -- list workers with their tool counts and online/offline status
- **Model picker** (`/model`) -- list available models grouped by provider, select one to set as the workspace model, or reset to the server default
- **Key picker** (`/keys`) -- list API keys and revoke them

All pickers support arrow key navigation and Escape to cancel.

## Interface Layout

The TUI renders the following sections from top to bottom:

- **Header** -- connection status, worker name, workspace name, and keyboard shortcut hints
- **Chat history** -- user, assistant, and system messages
- **Active tool calls** -- tools currently being executed by the worker
- **Subagent blocks** -- progress of active subagent tasks
- **Streaming response** -- real-time LLM output as it arrives
- **Status bar** -- current agent status (idle, streaming, executing_tool)
- **Cron notifications** -- alerts when scheduled tasks fire in other sessions
- **Tool approval prompt** -- when a tool call needs user permission
- **Input bar** -- multi-line text area
- **Autocomplete popup** -- slash command completions

## See Also

- [Getting Started](../guide/getting-started.md) -- quick-start guide
- [Configuration](../guide/configuration.md) -- all CLI flags and env vars
- [Telegram Bot](./telegram.md) -- alternative Telegram client
- [Building a Custom Client](./custom-client.md) -- using the tRPC API directly
- [Tool Approval](../server/tool-approval.md) -- approval rules and `permissions.jsonc`
