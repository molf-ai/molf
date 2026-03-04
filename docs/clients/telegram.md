# Telegram Bot

## Overview

The Telegram bot client connects to both a Molf server and the Telegram Bot API, letting you chat with your AI assistant directly in Telegram. It supports streaming responses (edit-in-place), media uploads, access control, and session management — all through a familiar chat interface.

Built on the [grammY](https://grammy.dev/) framework with API rate-limit protection via `@grammyjs/transformer-throttler`. Only private (DM) chats are supported.

## Setup

1. **Create a Telegram bot** — talk to [@BotFather](https://t.me/BotFather) on Telegram and use `/newbot` to get a bot token.
2. **Get your server auth token** — printed by the server on startup.
3. **Start the bot**:

```bash
bun run dev:client-telegram -- --token <server-token> --bot-token <telegram-token>
```

### CLI Flags

| Flag | Short | Description | Default | Env Var |
|------|-------|-------------|---------|---------|
| `--server-url` | `-s` | WebSocket server URL | `ws://127.0.0.1:7600` | `MOLF_SERVER_URL` |
| `--token` | `-t` | Server auth token (required) | — | `MOLF_TOKEN` |
| `--worker-id` | `-w` | Target worker ID | — | `MOLF_WORKER_ID` |
| `--bot-token` | `-b` | Telegram bot token (required) | — | `TELEGRAM_BOT_TOKEN` |
| `--allowed-users` | — | Comma-separated allowed users | — | `TELEGRAM_ALLOWED_USERS` |
| `--config` | `-c` | Path to molf.yaml config file | — | — |

## Configuration

The Telegram client can be configured via the `telegram` section in `molf.yaml`:

```yaml
telegram:
  botToken: "123456:ABC-DEF..."
  allowedUsers:
    - "@username"
    - "12345678"
  ackReaction: "eyes"            # Emoji reaction on message receipt
  streamingThrottleMs: 300       # Edit-in-place throttle interval (ms)
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `botToken` | — | Telegram bot token from BotFather |
| `allowedUsers` | `[]` (allow all) | List of Telegram user IDs (numeric) or usernames (`@name`) |
| `ackReaction` | `"eyes"` | Emoji reaction added to each incoming message as acknowledgment |
| `streamingThrottleMs` | `300` | Minimum interval (ms) between message edits during streaming |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (alternative to `--bot-token` or YAML) |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated allowed users (alternative to `--allowed-users` or YAML) |
| `MOLF_TOKEN` | Server auth token |
| `MOLF_SERVER_URL` | Server URL |
| `MOLF_WORKER_ID` | Target worker ID |

### Priority

Configuration is resolved in this order (highest priority first):

1. Environment variables
2. CLI flags
3. YAML config file
4. Built-in defaults

## Bot Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/clear` | Start a new session (alias for `/new`) |
| `/abort` | Cancel the running agent |
| `/stop` | Cancel the running agent (alias for `/abort`) |
| `/worker` | Select a worker (shows an inline keyboard) |
| `/model` | Browse and select a model (shows inline keyboard) |
| `/status` | Show connection and session status |
| `/help` | Show help message (paginated with inline keyboard) |

## Model Selection

The `/model` command displays an inline keyboard listing all available models grouped by provider, plus a "Default (server)" option at the top.

Tapping a model name sets it as the workspace model via `workspace.setConfig`. Tapping "Default (server)" clears the model override.

The model list is fetched from the server's `provider.listModels` tRPC procedure, so it reflects whichever providers the server has configured and detected API keys for.

## Shell Shortcut (`!` / `!!`)

Two prefixes let you run shell commands directly on the worker — bypassing the LLM agent entirely:

| Prefix | Behavior |
|--------|----------|
| `!` | Execute command and **save the result to session history** (visible to the LLM on subsequent turns) |
| `!!` | Execute command **fire-and-forget** — result is displayed but **not** saved to the session |

```
!ls -la          # saved to context — the LLM can reference this output
!!git status     # fire-and-forget — visible to you only
```

When using `!`, the result is injected as a synthetic message into the session, so the LLM can reference it. The agent must be idle — if busy, the bot replies with a descriptive error suggesting `!!` instead.

**Output handling:** If the combined stdout + stderr is ≤ 3000 characters, the result is sent inline with HTML formatting. For larger output, a summary (first/last 10 lines of stdout) is sent inline and the full output is attached as `output.txt`.

**Requirements:** The connected worker must expose the `shell_exec` tool. If no worker is connected (`/worker` not set) or the worker lacks the tool, the bot replies with a descriptive error.

> **Note:** Shell output is currently displayed as-is. Commands that print sensitive environment variables (e.g. `env`, `printenv`, `cat .env`) will expose their values in the chat. Automatic redaction of API keys and tokens is not yet implemented.

## Access Control

The `allowedUsers` setting controls who can use the bot.

- **Telegram user IDs** — numeric values like `12345678`
- **Usernames** — with or without the `@` prefix, like `@alice` or `alice`
- **Empty list** — allows everyone (no restrictions)

Unauthorized messages are silently dropped.

::: tip Finding your Telegram user ID
Send a message to [@userinfobot](https://t.me/userinfobot) on Telegram to get your numeric user ID.
:::

## Streaming & Message Rendering

The bot uses an **edit-in-place** streaming approach:

1. When the agent starts generating text, the bot sends a new message.
2. As content streams in, the bot edits that message with the accumulated text.
3. Edits are throttled to the configured interval (default 300ms) to avoid Telegram rate limits.
4. If the accumulated text exceeds **4000 characters** (under Telegram's 4096-char limit), the bot starts a new message and continues streaming there.

Markdown output from the agent is converted to Telegram HTML format:
- `**bold**` → **bold**, `*italic*` → *italic*, `` `code` `` → `code`, fenced code blocks → `<pre>` blocks, links → clickable links

If HTML parsing fails (malformed tags during streaming), the bot falls back to plain text.

## Media Handling

The bot supports sending files and media to the agent:

### Supported Types

| Telegram Type | Handled As |
|---------------|------------|
| Photos | image/jpeg |
| Documents | Original MIME type |
| Audio | Original MIME type |
| Voice messages | audio/ogg |
| Video | Original MIME type |
| Video notes | video/mp4 |
| Stickers | image/webp or application/x-tgsticker |

### Limits

- **Maximum file size**: 15MB (validated before and after download)
- **Media groups (albums)**: Buffered for 500ms, then sent as a single prompt with all attachments
- **Long text messages**: Messages over 4000 characters are buffered as fragments (up to 12 parts, 50K total, 1.5s flush timeout) and sent as a single prompt

## Session Management

Each Telegram chat is mapped to a Molf session:

- The bot maps **Telegram chat IDs** to **Molf session IDs** automatically.
- `/new` creates a fresh session for the current worker.
- Session metadata includes `{ client: "telegram", chatId }` for identification.
- On bot restart, sessions are **restored** from the server by querying for sessions with matching Telegram metadata — your session history is preserved.

## Tool Approval

When a tool call requires user confirmation, the bot sends a message displaying the tool name and arguments along with three inline keyboard buttons:

| Button | Action | tRPC Call |
|--------|--------|-----------|
| **Approve** | Allow this single tool call | `tool.approve` with `always: false` |
| **Always** | Allow this tool+pattern going forward (persisted to `permissions.jsonc`) | `tool.approve` with `always: true` |
| **Deny** | Reject this tool call | `tool.deny` |

After the user taps a button, the bot edits the message to show the outcome: "Approved", "Always approved", or "Denied".

### Session Watching

When a Telegram chat sends a message (text or media), the bot automatically calls `approvalManager.watchSession()` for that chat's session. This ensures the bot is subscribed to approval events and can present inline keyboard prompts as they arise. No manual setup is required.

See [Tool Approval](/server/tool-approval) for details on how approval rules are evaluated and how to customize per-worker rulesets.

::: tip Subagent approvals
When a subagent requires tool approval, the approval prompt appears identically to a normal tool approval — the Telegram bot extracts approval events from both direct and subagent-wrapped events. No special handling is needed.
:::

## See Also

- [Configuration](/guide/configuration) — full Telegram YAML config reference and priority rules
- [Terminal TUI](/clients/terminal-tui) — alternative terminal-based client
- [Building a Custom Client](/clients/custom-client) — build your own client using the tRPC protocol
- [Subagents](/server/subagents) — how subagents work and how approval events are forwarded
- [Troubleshooting](/reference/troubleshooting) — common Telegram bot issues and fixes
