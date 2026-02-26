# Tool Approval

## Overview

The tool approval gate intercepts every LLM tool call on the server before it reaches a worker for execution. Each call is evaluated against per-worker rulesets to produce one of three outcomes:

- **allow** — the tool call proceeds silently to the worker.
- **deny** — the tool call is blocked and an error message is returned to the LLM as the tool result. The user is never prompted.
- **ask** — the tool call is held and a `tool_approval_required` event is emitted to the connected client. The agent pauses until the user approves or denies the call.

The approval gate runs inside `AgentRunner`, after the optional `beforeExecute` hook and before `ToolDispatch`. It is always present. To auto-approve everything, see [Disabling the Approval Gate](#disabling-the-approval-gate).

## How It Works

```
LLM requests tool call
    |
AgentRunner.execute()
    |
ApprovalGate.evaluate(toolName, args, sessionId, workerId)
    |  returns action: "allow" | "deny" | "ask"
    |
    +-- allow --> ToolDispatch --> Worker executes tool
    |
    +-- deny  --> return ToolDeniedError.message as tool result
    |
    +-- ask   --> ApprovalGate.requestApproval(...)
                    |
                    +--> emits tool_approval_required event (with approvalId)
                    |
                    +--> ApprovalGate.waitForApproval(approvalId) blocks
                    |
                    Client receives event, prompts user
                    |
                    User responds (approve / always / deny)
                    |
                    Client calls tool.approve or tool.deny
                    |
                    Router calls ApprovalGate.reply(...)
                    |
                    +-- approved --> ToolDispatch --> Worker executes tool
                    +-- rejected --> return ToolRejectedError.message as tool result
```

When a session is aborted while an approval is pending, the pending approval is cancelled and the abort propagates normally. On worker disconnect, all pending approvals for sessions bound to that worker are cleared.

## Default Rules

Every worker starts with these default rules. They are seeded into the worker's `permissions.jsonc` file on first access.

| Tool | Default | Allow Patterns | Deny Patterns |
|------|---------|----------------|---------------|
| `read_file` | allow | `*.env.example` | `*.env`, `*.env.*`, `*credentials*`, `*secret*` |
| `glob` | allow | — | — |
| `grep` | allow | — | — |
| `write_file` | allow | — | `*.env`, `*.env.*` |
| `edit_file` | allow | — | `*.env`, `*.env.*` |
| `skill` | ask | — | — |
| `shell_exec` | ask | — | — |
| `*` (catch-all) | ask | — | — |

The `*` catch-all matches any tool not explicitly listed, including MCP tools. MCP tools are matched using their full prefixed name (e.g., `mcp:toolname`).

::: info Shell exec via \!
The TUI's `!` shortcut for running shell commands bypasses the approval gate entirely. It is a user-initiated command, not an LLM tool call, so approval does not apply.
:::

## Rule Evaluation

### Pattern Matching

Patterns are matched against tool arguments using [picomatch](https://github.com/micromatch/picomatch) globs with `dot: true` and `bash: true` options. This means patterns like `*.env` will match dotfiles and support bash-style globbing.

What counts as a "pattern" depends on the tool:

| Tool | Pattern Source |
|------|----------------|
| `read_file`, `write_file`, `edit_file` | `args.path` or `args.file_path` |
| `glob` | `args.pattern` or `args.path` |
| `grep` | `args.path` |
| `skill` | `args.name` (the skill name) |
| `shell_exec` | Shell command sub-commands (see [Shell Command Parsing](#shell-command-parsing)) |
| MCP tools (`mcp:*`) | The full tool name |
| Other tools | *(none — uses default action only)* |

### Evaluation Order

Rules are evaluated in this order:

1. **Find the matching rule.** Look up the tool by exact name. If no exact match, fall back to the `*` catch-all.
2. **Check deny patterns** across ALL rulesets (static + runtime). If any deny pattern matches any of the tool's patterns, the result is **deny**.
3. **Check allow patterns** across ALL rulesets. Later rulesets (runtime) take priority over earlier ones (static). If any allow pattern matches, the result is **allow**.
4. **Fall back** to the rule's `default` action.

Deny always wins: a deny pattern cannot be overridden by an allow pattern.

### Pipeline Handling

For `shell_exec` calls that contain pipelines or command chains (`|`, `&&`, `||`, `;`), each sub-command is evaluated independently:

- If **any** sub-command evaluates to **deny**, the entire command is denied.
- If **any** sub-command evaluates to **ask** (and none are denied), the entire command requires approval.
- Only if **all** sub-commands evaluate to **allow** does the entire command proceed silently.

## Shell Command Parsing

Shell commands passed to `shell_exec` are parsed to extract individual sub-commands for rule evaluation. The parser uses [tree-sitter-bash](https://github.com/nicolo-ribaudo/tree-sitter-bash) (loaded as a WASM module) for accurate AST-based parsing, with a regex fallback for environments where tree-sitter is unavailable.

The parser handles pipelines (`|`), command lists (`&&`, `||`, `;`), and bare commands. Each sub-command is resolved to a pattern string using an arity table that determines how many tokens form the "command prefix":

**Arity 1** — simple commands where the first token is the full command:

`cat`, `ls`, `grep`, `rm`, `cp`, `mv`, `mkdir`, `chmod`, `echo`, `which`, `tail`, `head`, `touch`, `pwd`, `wc`, `whoami`, `date`, `uname`, `env`, `printenv`, `cd`, `find`, `sed`, `awk`, `sort`, `uniq`, `cut`, `tr`, `tee`, `xargs`, `diff`, `curl`, `wget`, `tar`, `zip`, `unzip`, `ssh`, `scp`, `rsync`, `dd`, `shutdown`, `reboot`, `mkfs`, `sh`, `bash`, `zsh`

**Arity 2** — tools with subcommands (first two tokens form the command):

`git`, `npm`, `bun`, `docker`, `cargo`, `kubectl`, `pip`, `pnpm`, `yarn`, `terraform`, `systemctl`, `bunx`

**Arity 3** — deep subcommand tools (first three tokens):

`npm run`, `bun run`, `docker compose`, `git remote`, `git stash`, `aws`, `gcloud`, `gh`

### "Always Approve" Pattern Generation

When a user selects "Always Approve" for a shell command, the parser generates a glob pattern from the command's arity prefix. For example:

- `git push origin main` (arity 2 for `git`) generates pattern `git push *`
- `npm run build` (arity 3 for `npm run`) generates pattern `npm run build`
- `cat README.md` (arity 1 for `cat`) generates pattern `cat *`

This means "always approve `git push`" will also approve `git push --force origin main` and any other `git push` variant.

## Per-Worker Permissions

### File Location

Each worker's rules are stored as a JSONC file at:

```
{dataDir}/workers/{workerId}/permissions.jsonc
```

The file is seeded automatically with the default rules on first access (the first time the approval gate evaluates a tool call for that worker).

### File Format

The file uses JSONC (JSON with `//` and `/* */` comments). Example:

```jsonc
// Tool approval rules for this worker.
// Each tool has a "default" action and optional "allow"/"deny" pattern arrays.
// Actions: "allow" (proceed silently), "deny" (block), "ask" (prompt user).
// Deny patterns always take priority over allow patterns.
{
  "version": 1,
  "rules": {
    "read_file": {
      "default": "allow",
      "allow": ["*.env.example"],
      "deny": ["*.env", "*.env.*", "*credentials*", "*secret*"]
    },
    "glob": {
      "default": "allow"
    },
    "grep": {
      "default": "allow"
    },
    "write_file": {
      "default": "allow",
      "deny": ["*.env", "*.env.*"]
    },
    "edit_file": {
      "default": "allow",
      "deny": ["*.env", "*.env.*"]
    },
    "skill": {
      "default": "ask"
    },
    "shell_exec": {
      "default": "ask",
      "allow": [],
      "deny": []
    },
    "*": {
      "default": "ask"
    }
  }
}
```

### Manual Editing

You can edit `permissions.jsonc` directly to customize rules. Changes take effect on the next tool call evaluation (the file is loaded from disk each time). Common customizations:

- Add a command to `shell_exec.allow` to auto-approve it: `"allow": ["git status", "bun test *"]`
- Add a tool entry to auto-approve all calls: `"my_tool": { "default": "allow" }`
- Add deny patterns to block specific operations: `"write_file": { "default": "allow", "deny": ["*.env", "/etc/*"] }`

### Automatic Updates

When a user selects "Always Approve" in a client, the approval gate:

1. Adds the matching patterns to the tool's `allow` array in the worker's `permissions.jsonc` file.
2. Adds the same patterns to a runtime in-memory layer scoped to the current session.

The persisted patterns apply to all future sessions on that worker. The runtime layer provides immediate effect for the current session without re-reading the file.

## Runtime "Always Approve" and Cascade Resolution

The runtime approval layer is an in-memory per-session ruleset that sits on top of the static per-worker permissions. When a user selects "Always Approve":

1. The pattern is added to both the runtime layer (session-scoped) and the static layer (disk, worker-scoped).
2. All other pending approval requests for the same session are **re-evaluated** against the updated rulesets.
3. Any pending request that now evaluates to "allow" is automatically resolved without further user interaction.

This cascade resolution means that approving `git push *` will also auto-resolve any other pending `git push` variants in the same session's approval queue.

## tRPC Procedures

### `tool.approve`

Approves a pending tool call.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `approvalId` | string | yes | The approval ID from the `tool_approval_required` event |
| `always` | boolean | no | When `true`, adds an "always approve" rule for this tool and pattern |

**Response:** `{ applied: boolean }` — `true` if the approval was applied, `false` if the `approvalId` was not found (e.g., already cancelled or timed out).

### `tool.deny`

Denies a pending tool call.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `approvalId` | string | yes | The approval ID from the `tool_approval_required` event |
| `feedback` | string | no | Optional feedback message returned to the LLM as the tool result |

**Response:** `{ applied: boolean }`

### `tool_approval_required` Event

Emitted on the `agent.onEvents` subscription when a tool call requires user approval.

```ts
{
  type: "tool_approval_required",
  approvalId: string,   // unique ID for this approval request
  toolName: string,     // e.g. "shell_exec", "mcp:my-tool"
  arguments: string,    // the tool call arguments as a JSON string
  sessionId: string
}
```

On client reconnect, any pending approval events are automatically replayed via the `agent.onEvents` subscription so the client can re-render approval prompts.

## Client Integration

Each client handles tool approval prompts differently:

- **Terminal TUI** — keyboard-driven with Y/A/N keys and a feedback text input on deny. See [Terminal TUI](/clients/terminal-tui#tool-approval).
- **Telegram Bot** — inline keyboard buttons (Approve, Always, Deny). See [Telegram Bot](/clients/telegram#tool-approval).
- **Custom Clients** — subscribe to `tool_approval_required` events and call `tool.approve` / `tool.deny` with the `approvalId`. See [Custom Client](/clients/custom-client#tool-approval).

## Disabling the Approval Gate

::: danger Use only in isolated environments
Disabling approval gives the LLM **unrestricted access** to shell commands, file writes, and any other registered tools without user confirmation. Only do this on a disposable VM, container, CI runner, or air-gapped sandbox — **never on a machine with access to production data, credentials, or the open internet.**
:::

Edit the worker's `permissions.jsonc` file (at `{dataDir}/workers/{workerId}/permissions.jsonc`) and set the catch-all rule default to `"allow"`:

```jsonc
{
  "version": 1,
  "rules": {
    "*": {
      "default": "allow"
    }
  }
}
```

This still respects individual deny patterns. You can keep deny rules for sensitive paths (e.g. `*.env`, `*credentials*`) while allowing everything else. The approval gate remains active — it just evaluates to "allow" for everything not explicitly denied.

To truly allow **everything** (including writes to `.env` files and other normally-denied patterns), remove all deny arrays too:

```jsonc
{
  "version": 1,
  "rules": {
    "read_file": { "default": "allow" },
    "write_file": { "default": "allow" },
    "edit_file": { "default": "allow" },
    "glob": { "default": "allow" },
    "grep": { "default": "allow" },
    "skill": { "default": "allow" },
    "shell_exec": { "default": "allow" },
    "*": { "default": "allow" }
  }
}
```

### Risks

- The LLM can execute arbitrary shell commands (`rm -rf`, network calls, package installs, etc.)
- The LLM can read and overwrite any file the worker process has access to, including secrets and credentials
- MCP tools and skills are invoked without any confirmation
- There is no undo — destructive actions happen immediately

If you still need this for automated pipelines or local experimentation, consider restricting the worker's OS-level permissions (e.g., run in a container with limited filesystem and network access) as a secondary safety layer.

## Configuration Reference

| Setting | Location | Type | Default | Description |
|---------|----------|------|---------|-------------|
| `permissions.jsonc` | `{dataDir}/workers/{workerId}/` | JSONC file | Seeded with defaults | Per-worker tool rules |

See [Configuration](/guide/configuration) for the full server configuration reference.
