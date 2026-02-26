# Troubleshooting

Common issues and solutions, organized by component.

## Using Logs

All Molf processes produce structured logs that help diagnose issues. By default, logs are written to both the console (pretty-formatted) and rotating files (JSONL).

**Enable debug logging** to see detailed diagnostics:

```bash
MOLF_LOG_LEVEL=debug GEMINI_API_KEY=<key> bun run dev:server
MOLF_LOG_LEVEL=debug bun run dev:worker -- --name my-worker --token <token>
```

**Log file locations:**

| Process | Location |
|---------|----------|
| Server | `{dataDir}/logs/server.log` |
| Worker | `{workdir}/.molf/logs/worker.log` |

**Read log files:**

```bash
tail -f data/logs/server.log | jq '.'
grep '"error"' .molf/logs/worker.log | jq '.'
```

See [Logging Reference](/reference/logging) for the full list of log categories and levels.

## Server Issues

| Symptom | Check | Fix |
|---------|-------|-----|
| Server won't start | Port already in use (`EADDRINUSE`) | Change port with `--port` or kill the existing process |
| "GEMINI_API_KEY not set" | Missing API key environment variable | Export `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY` for Anthropic) |
| Token changes on every restart | No fixed token configured | Set `MOLF_TOKEN` env var for a stable token across restarts |
| "Config file not found" | `molf.yaml` not at expected path | Pass `--config /path/to/molf.yaml` or create one in the working directory |
| LLM errors after model change | Invalid model name in config | Check supported model names in [Server Overview](/server/overview) |
| Context length errors | Long session exceeding model limit | Automatic context pruning and summarization handle this. When context usage reaches 80%, the server automatically summarizes older messages. Context pruning handles remaining overflow. Start a new session if persistent. |
| Data directory permission errors | Server can't write to `dataDir` | Ensure the data directory exists and is writable |
| Logs not appearing | `MOLF_LOG_FILE=none` is set, or data directory not writable | Unset `MOLF_LOG_FILE`; check `{dataDir}/logs/` permissions |

## Worker Issues

| Symptom | Check | Fix |
|---------|-------|-----|
| Worker won't connect | Wrong server URL or token | Verify `--server-url` and `--token` match the server output |
| Worker keeps reconnecting | Server not running or network issue | Confirm the server is up; check firewall rules for the port |
| Tools not appearing for clients | Worker registered but not bound to session | Check that the session's `workerId` matches the worker; try `/worker` in TUI to switch |
| Skills not loading | `SKILL.md` in wrong location or bad frontmatter | Verify path: `{workdir}/.agents/skills/{name}/SKILL.md` (or `.claude/skills/`); check YAML frontmatter syntax |
| Tool execution hangs | Blocking command in `shell_exec` | Use the `timeout` parameter; default is 120s. Check for interactive prompts. |
| "shell not found" errors | Worker can't resolve user shell | Set `$SHELL` env var; falls back to `/bin/zsh` (macOS) or `bash` or `/bin/sh` |
| File path errors | Paths not resolving correctly | All paths are relative to `--workdir`; verify the workdir is correct |
| AGENTS.md not applied | File not in expected location | Place at `{workdir}/AGENTS.md` or `{workdir}/CLAUDE.md` |
| Worker logs missing | File logging disabled or workdir not writable | Check `{workdir}/.molf/logs/` exists; unset `MOLF_LOG_FILE` |

## TUI Client Issues

| Symptom | Check | Fix |
|---------|-------|-----|
| "No workers connected" | No worker running | Start a worker first with `bun run dev:worker` |
| Can't resume a session | Session bound to a different worker | Start the correct worker (same workdir/UUID) or create a new session |
| Messages not streaming | Event subscription lost | Restart the client; sessions persist on the server |
| Escape doesn't exit | Agent is running | Press Escape once to abort the agent, then again to exit |
| Slash commands not working | Missing `/` prefix or typo | Type `/help` to see all available commands; tab completion is available |
| Text input feels broken | Multi-line editing confusion | Use arrow keys to navigate; Ctrl+K to clear line; see [TUI Client](/clients/terminal-tui) for keyboard controls |
| `/editor` doesn't work | `$EDITOR` or `$VISUAL` not set | Set the `EDITOR` env var (e.g., `export EDITOR=vim`) |

## Telegram Bot Issues

| Symptom | Check | Fix |
|---------|-------|-----|
| Bot not responding | Wrong bot token or bot not started | Verify `TELEGRAM_BOT_TOKEN`; ensure the bot process is running |
| Messages silently ignored | User not in allowlist | Add user's Telegram ID or `@username` to `allowedUsers` config |
| "Unauthorized" from server | Server token mismatch | Ensure `--token` matches the Molf server's auth token |
| Messages cut off mid-response | Telegram 4096 char limit hit | Automatic chunking handles this; if content still looks wrong, check for rendering errors in logs |
| Streaming edits are slow | High throttle interval | Lower `streamingThrottleMs` in YAML config (default: 300ms) |
| Media upload fails | File too large | Max file size is 15MB; reduce the file size before sending |
| Bot only works in DMs | Group chats not supported | The Telegram client only handles private (DM) chats |
| Album/media group sent as separate messages | Media group buffering failed | Media groups are buffered for 500ms; try sending the album again |

## Tool Approval

| Symptom | Check | Fix |
|---------|-------|-----|
| Tool calls hang waiting for approval | Approval is enabled (default) but no client is connected to respond | Connect a client (TUI or Telegram) to respond to approval prompts, or set `"*": { "default": "allow" }` in the worker's `permissions.jsonc` to auto-approve all tools |
| Tool denied unexpectedly | A deny pattern in `permissions.jsonc` matches the tool call arguments | Check `{dataDir}/workers/{workerId}/permissions.jsonc` for overly broad deny patterns. Deny rules always take priority over allow rules. |
| "Always approve" not working for a specific pattern | A deny rule in the static ruleset takes priority (evaluation order: deny > allow > default) | Remove the conflicting deny pattern from `permissions.jsonc`. See [Tool Approval](/server/tool-approval) for how rule evaluation works. |
| All tool calls require approval for a new tool | Unknown tools match the `*` catch-all rule (default: `ask`) | Add a custom rule for the tool in `permissions.jsonc` or approve with "Always" (A) in the TUI to persist the pattern |

## Common Cross-Component Issues

| Symptom | Check | Fix |
|---------|-------|-----|
| `UNAUTHORIZED` error | Invalid or missing auth token | Ensure all components (server, worker, clients) use the same token |
| `PRECONDITION_FAILED` | Worker disconnected | Reconnect the worker; sessions auto-resume when the same `workerId` reconnects |
| `NOT_FOUND` for session | Session ID doesn't exist | Session may have been deleted; create a new one or check `{dataDir}/sessions/` |
| `CONFLICT` on prompt | Agent already running | Wait for the current turn to finish or call `agent.abort` first |
| Tool timeout (120s) | Long-running command | Pass a higher `timeout` value to `shell_exec`, or break the command into smaller steps |
| Agent stuck in a loop | Doom loop detected (3 identical tool calls) | The agent auto-injects a warning; if persistent, abort and rephrase your prompt |
| "Connection closed" | WebSocket dropped | Clients and workers auto-reconnect; check network stability |
| Session data missing after restart | Data directory changed | Ensure `--data-dir` points to the same location across restarts |

## See Also

- [Getting Started](/guide/getting-started) — quick-start guide to verify your setup
- [Configuration](/guide/configuration) — full config reference for all components
- [Protocol Reference](/reference/protocol) — error codes and event types
- [Logging Reference](/reference/logging) — log categories, levels, and file format
