# Terminal TUI

## Overview

The Terminal TUI is a full-featured chat interface for your terminal, built with Ink 5 and React 18. It connects to a Molf server over tRPC WebSocket and provides streaming output, slash commands, multi-line editing, session management, and tool approval — all from the command line.

## Setup

Start the TUI client:

```bash
bun run dev:client-tui -- --token <token>
```

### CLI Flags

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--server-url` | `-s` | WebSocket server URL | `ws://127.0.0.1:7600` |
| `--token` | `-t` | Server auth token (required) | — |
| `--worker-id` | `-w` | Target worker ID | — |
| `--session-id` | — | Resume an existing session | — |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `MOLF_TOKEN` | Server auth token (alternative to `--token`) |
| `MOLF_SERVER_URL` | Server URL (alternative to `--server-url`) |
| `MOLF_WORKER_ID` | Target worker ID (alternative to `--worker-id`) |
| `MOLF_SESSION_ID` | Session to resume (alternative to `--session-id`) |

### Session Initialization

On startup, the TUI resolves a session in this order:

1. If `--session-id` is provided, loads that specific session.
2. Otherwise, tries to load the most recent session (filtered by worker if `--worker-id` is set).
3. If no sessions exist, creates a new session with the first available worker.

Once a session is resolved, the client subscribes to agent events and the chat is ready.

## Slash Commands

Type a `/` to enter command mode. Tab completion is supported — press Tab to complete, then Up/Down to cycle through matches.

| Command | Aliases | Description |
|---------|---------|-------------|
| `/clear` | `/new`, `/reset` | Start a new session (the old session is preserved on disk) |
| `/exit` | `/quit`, `/q` | Exit the TUI |
| `/help` | `/commands` | Show all available commands |
| `/sessions` | `/resume` | Browse and switch between sessions |
| `/rename <name>` | — | Rename the current session |
| `/worker` | `/workers`, `/w` | List and switch between connected workers |
| `/editor` | `/edit`, `/e` | Open `$VISUAL` or `$EDITOR` to compose a message |

## Keyboard Controls

| Key | Action |
|-----|--------|
| Left / Right | Move cursor one character |
| Up / Down | Move cursor one line; overflows into input history navigation |
| Ctrl+Left / Ctrl+Right | Move cursor one word |
| Alt+Left / Alt+Right | Move cursor one word (alternative binding) |
| Home | Move cursor to start of line |
| End | Move cursor to end of line |
| Ctrl+K | Delete from cursor to end of line |
| Ctrl+U | Delete from cursor to start of line |
| Ctrl+W | Delete word backward |
| Alt+Backspace | Delete word backward (alternative binding) |
| Delete | Delete character forward |
| Enter | Send the message |
| Escape | Abort the running agent, or exit if idle |

## Text Buffer

The TUI supports multi-line message editing:

- Type normally to enter text. Line wrapping is handled automatically.
- The input area shows up to **6 visible lines** at a time. If your message is longer, the viewport scrolls to keep the cursor visible.
- Use the `/editor` command to open an external editor for composing longer messages.

## Tool Approval

When a tool call requires approval, the TUI displays an inline prompt showing the tool name and arguments. You can approve or deny the call directly from the keyboard. The agent pauses until you respond.

See the [Protocol Reference](/reference/protocol) for details on the `tool_approval_required` event.

## See Also

- [Getting Started](/guide/getting-started) — quick-start guide with three-terminal setup
- [Configuration](/guide/configuration) — TUI client CLI flags and environment variables
- [Telegram Bot](/clients/telegram) — alternative client for Telegram
- [Troubleshooting](/reference/troubleshooting) — common TUI issues and fixes
