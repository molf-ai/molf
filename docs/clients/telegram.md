# Telegram Bot

The Telegram bot client connects to a Molf server over WebSocket and exposes AI assistant functionality through the Telegram Bot API, built on the [grammY](https://grammy.dev/) framework. It supports streaming responses, media uploads, tool approval via inline keyboards, session management, and access control -- all through Telegram DMs.

## Setup

1. **Create a Telegram bot** -- talk to [@BotFather](https://t.me/BotFather) on Telegram and use `/newbot` to get a bot token.
2. **Start the bot**:

```bash
pnpm dev:client-telegram -- --bot-token <telegram-token>
```

On first run, the bot handles TLS trust and authentication through Telegram itself (via the SetupGate middleware):

- **TLS approval** -- if the server uses a self-signed certificate, the bot sends an inline keyboard to the first user who messages it, showing the server's TLS fingerprint with Approve/Reject buttons.
- **Pairing** -- if no auth token is available, the bot prompts the user to provide a 6-digit pairing code via `/pair <code>`. The pairing code must be generated on the server or from an already-paired client.

The bot starts polling Telegram immediately and responds to users during setup with setup instructions. Normal command handling is blocked by the SetupGate middleware until setup completes.

## CLI Flags

| Flag | Short | Env Var | Default | Description |
|------|-------|---------|---------|-------------|
| `--server-url` | `-s` | `MOLF_SERVER_URL` | `wss://127.0.0.1:7600` | WebSocket server URL |
| `--token` | `-t` | `MOLF_TOKEN` | -- | Server auth token or API key |
| `--worker-id` | `-w` | `MOLF_WORKER_ID` | (auto-select first online worker) | Target worker UUID |
| `--bot-token` | `-b` | `TELEGRAM_BOT_TOKEN` | -- | Telegram bot token (required) |
| `--allowed-users` | -- | `TELEGRAM_ALLOWED_USERS` | -- | Comma-separated allowed Telegram user IDs or usernames |
| `--tls-ca` | -- | `MOLF_TLS_CA` | -- | Path to a trusted CA certificate PEM file |

## Access Control

The `allowedUsers` setting restricts who can interact with the bot:

- **User IDs** -- numeric values like `12345678`
- **Usernames** -- with or without `@`, like `@alice` or `alice`
- **Empty list** -- if no users are configured, all messages are rejected (the bot logs a warning on startup)

Unauthorized messages are silently dropped by the access middleware.

## Bot Commands

These commands are registered with Telegram's command menu (visible in the `/` autocomplete):

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/clear` | Start a new session (alias) |
| `/abort` | Cancel the running agent |
| `/stop` | Cancel the running agent (alias) |
| `/workspace` | Switch workspace (shows inline keyboard, or `/workspace <name>` to switch by name) |
| `/worker` | Select a worker (shows inline keyboard with tool counts and online status) |
| `/model` | Select a model (two-step: first shows provider list, then shows models for the selected provider) |
| `/status` | Show connection info: server status, agent state, workspace, session, worker, tool count |
| `/help` | Show command reference |

### Shell shortcut

Prefix a message with `!` to run a shell command on the worker:

- `!ls -la` -- execute and save output to session context
- `!!git status` -- execute fire-and-forget (not saved to context)

## Streaming and Rendering

The bot uses edit-in-place streaming:

1. When the agent starts generating, the bot sends a new message.
2. As content streams in, the message is edited with accumulated text, throttled to `streamingThrottleMs` (default 300 ms) to stay within Telegram rate limits.
3. If text exceeds 4000 characters, a new message is started.

Markdown from the agent is converted to Telegram HTML (`**bold**`, `` `code` ``, fenced code blocks, links). If HTML parsing fails during streaming, the bot falls back to plain text.

## Media Handling

Send files and media to the bot -- they are uploaded to the server and included as attachments in the prompt:

| Telegram Type | Handled As |
|---------------|------------|
| Photos | image/jpeg |
| Documents | Original MIME type |
| Audio | Original MIME type |
| Voice messages | audio/ogg |
| Video | Original MIME type |
| Stickers | image/webp or application/x-tgsticker |

Media groups (albums) are buffered for 500 ms and sent as a single prompt with all attachments. The maximum file size is 100 MB (limited by the server). Note that the Telegram Bot API has a separate 20 MB limit on `getFile()` -- files larger than this from Telegram will result in a user-friendly error message.

## Session Management

Each Telegram chat maps to a Molf session:

- The bot automatically maps **Telegram chat IDs** to **Molf session IDs**.
- `/new` creates a fresh session for the current worker and workspace.
- On restart, sessions are restored from the server by querying for sessions with matching Telegram metadata (`{ client: "telegram", chatId }`).
- Workspace events are subscribed automatically -- when a new session is created in the current workspace (e.g. by a cron job), the bot notifies the user with an inline keyboard to switch.

Only private (DM) chats are supported.

## Tool Approval

When a tool call requires approval, the bot sends a message with the tool name and arguments plus three inline keyboard buttons:

| Button | Action |
|--------|--------|
| **Approve** | Allow this single tool call |
| **Always** | Allow this tool+pattern going forward (persisted to `permissions.jsonc`) |
| **Deny** | Reject this tool call |

After the user taps a button, the message is edited to show the outcome.

See [Tool Approval](../server/tool-approval.md) for how approval rules work.

## Logging

The Telegram client uses `MOLF_LOG_LEVEL` (default: `info`) and `MOLF_LOG_FILE` for configuration:

- Console output uses the pretty formatter.
- File logging is disabled by default -- set `MOLF_LOG_FILE` to a path to enable it (JSONL format, 5 MB max, 3 file rotation).

## See Also

- [Configuration](../guide/configuration.md) -- all Telegram env vars and JSONC config
- [Terminal TUI](./terminal-tui.md) -- alternative terminal client
- [Building a Custom Client](./custom-client.md) -- using the oRPC API directly
- [Tool Approval](../server/tool-approval.md) -- approval rules and `permissions.jsonc`
