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

```jsonc
{
  "*": "ask",
  "read_file": {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*credentials*": "deny",
    "*secret*": "deny",
    "*.env.example": "allow"
  },
  "write_file": { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
  "edit_file": { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
  "glob": "allow",
  "grep": "allow",
  "skill": "ask",
  "shell_exec": "ask"
}
```

Within each tool entry, rules are evaluated top-to-bottom and the **last matching rule wins**. For example, `read_file` lists `"*.env": "deny"` followed by `"*.env.example": "allow"` — so `.env.example` files are correctly allowed despite matching the earlier deny pattern.

The `*` catch-all matches any tool not explicitly listed, including MCP tools. MCP tools use their qualified name (e.g., `filesystem_read_file`), which is the `{sanitizedServer}_{sanitizedTool}` format described in [MCP Integration](/worker/mcp#tool-naming).

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
| MCP tools | *(none — matched by tool name only, not by arguments)* |
| Other tools | *(none — uses default action only)* |

### Home Directory Expansion

Patterns in `permissions.jsonc` support `~/` and `$HOME/` prefixes, which are expanded to the actual home directory path at load time. For example:

- `"~/projects/*": "allow"` expands to `"/home/user/projects/*": "allow"`
- `"$HOME/.ssh/*": "deny"` expands to `"/home/user/.ssh/*": "deny"`

This expansion happens when the file is read, so the evaluated rules always use absolute paths.

### Evaluation Order

Rules are evaluated across up to three layers. **Agent deny rules act as a veto** — if the agent layer evaluates to "deny", that result is final and cannot be overridden. For non-deny results, all layers are merged into a single ordered list with **findLast** semantics.

**Layer order (first to last):**

1. **Agent permission** *(subagent sessions only)* — set automatically when a subagent session is created. Defines which tools the subagent type is allowed to use. **Agent "deny" rules are non-overridable** — they act as a veto. Agent "allow" and "ask" rules can be overridden by later layers. Not present for normal (non-subagent) sessions.
2. **Static rules** — per-worker rules from `permissions.jsonc` on disk.
3. **Runtime "always approve"** — session-scoped rules added when a user selects "Always Approve."

For agent "allow" and "ask" outcomes, later layers can still override earlier ones: static rules can tighten an agent "allow" to "ask" or "deny", and runtime rules can loosen an "ask" to "allow".

For normal (non-subagent) sessions, only layers 2 and 3 are present — behavior is unchanged.

1. **Check agent veto.** If an agent permission layer exists, evaluate it in isolation. If the result is "deny", return deny immediately — no further evaluation.
2. **Merge rulesets.** Agent permission (if present), static, and runtime rulesets are concatenated in order.
3. **Find the last match.** The merged list is scanned from the end. The first rule (from the end) where both the tool name and the value pattern match is the winner.
4. **Return the action.** If a matching rule is found, its action (`allow`, `deny`, or `ask`) is returned. If no rule matches, the default is **ask**.

### Pipeline Handling

For `shell_exec` calls that contain pipelines or command chains (`|`, `&&`, `||`, `;`), each sub-command is evaluated independently:

- If **any** sub-command evaluates to **deny**, the entire command is denied.
- If **any** sub-command evaluates to **ask** (and none are denied), the entire command requires approval.
- Only if **all** sub-commands evaluate to **allow** does the entire command proceed silently.

## Shell Command Parsing

Shell commands passed to `shell_exec` are parsed to extract individual sub-commands for rule evaluation. The parser uses [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) (loaded as a WASM module) for accurate AST-based parsing. If tree-sitter finds no command nodes, the parser falls back to a simple whitespace split of the input.

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
// Tool approval permissions for this worker.
// Edit this file to customize which tool calls are auto-allowed,
// auto-denied, or require manual approval.
//
// Format:
//   "toolName": "action"              — applies to all patterns
//   "toolName": { "pattern": "action" } — per-pattern rules
//   "*": "ask"                        — catch-all default
//
// Actions: "allow" | "deny" | "ask"
// Last matching rule wins. Patterns support globs (e.g. "*.env", "git *").
// Use ~/ or $HOME/ in patterns for home directory paths.
{
  "*": "ask",
  "read_file": {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*credentials*": "deny",
    "*secret*": "deny",
    "*.env.example": "allow"
  },
  "glob": "allow",
  "grep": "allow",
  "shell_exec": "ask"
}
```

There are two value types for each tool entry:

- **Simple:** `"toolName": "action"` — applies the action to all patterns. Equivalent to `{ "*": "action" }`.
- **Detailed:** `"toolName": { "pattern": "action", ... }` — per-pattern rules within the tool, evaluated top-to-bottom. The last matching pattern wins.

### Manual Editing

You can edit `permissions.jsonc` directly to customize rules. Changes take effect on the next tool call evaluation (the file is loaded from disk each time). Common customizations:

- Auto-approve specific shell commands: `"shell_exec": { "*": "ask", "git status": "allow", "bun test *": "allow" }`
- Auto-approve all calls for a tool: `"my_tool": "allow"`
- Deny specific patterns: `"write_file": { "*": "allow", "*.env": "deny", "/etc/*": "deny" }`

### Automatic Updates

When a user selects "Always Approve" in a client, the approval gate:

1. Appends an allow rule for the matching pattern to the end of the worker's permission config in `permissions.jsonc`. Because the last matching rule wins, this gives the new rule highest priority.
2. Adds the same rule to a runtime in-memory layer scoped to the current session.

The persisted rule applies to all future sessions on that worker. The runtime layer provides immediate effect for the current session without re-reading the file.

## Runtime "Always Approve" and Cascade Resolution

The runtime approval layer is an in-memory per-session ruleset that sits on top of the static per-worker permissions. When a user selects "Always Approve":

1. The pattern is added to both the runtime layer (session-scoped) and the static layer (disk, worker-scoped).
2. All other pending approval requests for the same session are **re-evaluated** against the updated rulesets.
3. Any pending request that now evaluates to "allow" is automatically resolved without further user interaction.

This cascade resolution means that approving `git push *` will also auto-resolve any other pending `git push` variants in the same session's approval queue.

## Subagent Permissions

When a subagent session is created, the server sets an **agent permission** ruleset for that session. This ruleset comes from the agent type definition — either from the server defaults (explore, general) or from a worker-provided agent `.md` file.

**Agent deny rules are non-overridable.** If the agent permission layer evaluates to "deny" for a tool call, that decision is final — static rules in `permissions.jsonc` and runtime "always approve" cannot override it. This ensures that a restrictive agent type (like `explore` with `"*": "deny"`) cannot have its security boundary weakened by server-level configuration or user actions.

Agent "allow" and "ask" rules remain overridable:

- A static rule can tighten an agent's "allow" to "ask" or "deny" (e.g., deny `.env` file access even if the agent allows `read_file`).
- A runtime "always approve" can loosen an "ask" to "allow" within the subagent session.

Agent permissions are scoped to the child session and cleared when the subagent completes or errors.

See [Subagents](/server/subagents) for the full list of built-in agent permissions and how to define custom ones.

## oRPC Procedures

### `tool.approve`

Approves a pending tool call.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionId` | string | yes | The session ID |
| `approvalId` | string | yes | The approval ID from the `tool_approval_required` event |
| `always` | boolean | no | When `true`, adds an "always approve" rule for this tool and pattern |

**Response:** `{ applied: boolean }` — `true` if the approval was applied, `false` if the `approvalId` was not found (e.g., already cancelled or timed out).

### `tool.deny`

Denies a pending tool call.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionId` | string | yes | The session ID |
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

Edit the worker's `permissions.jsonc` file (at `{dataDir}/workers/{workerId}/permissions.jsonc`) and set the catch-all to `"allow"`:

```jsonc
{
  "*": "allow"
}
```

Because the last matching rule wins, the `"*": "allow"` catch-all overrides all earlier rules — including any deny rules for specific tools. This config allows everything.

If you want to allow most tools but keep deny rules for sensitive paths, place the deny rules **after** the allow rules so they win:

```jsonc
{
  "read_file": {
    "*": "allow",
    "*.env": "deny",
    "*credentials*": "deny"
  },
  "write_file": { "*": "allow", "*.env": "deny" },
  "edit_file": { "*": "allow", "*.env": "deny" },
  "glob": "allow",
  "grep": "allow",
  "skill": "allow",
  "shell_exec": "allow"
}
```

Note: there is no `"*": "allow"` catch-all here. Instead, each tool is listed individually with an allow. The `read_file`, `write_file`, and `edit_file` tools keep their deny rules at the end of their blocks so those patterns are still denied. Any tool not listed falls through to the default action, which is `ask`.

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

## See Also

- [Server Overview](/server/overview) — server modules including the approval gate
- [Subagents](/server/subagents) — agent permissions and the 3-layer permission model
- [Worker Overview](/worker/overview) — per-worker permissions in the workdir layout
- [Built-in Tools](/worker/tools) — default approval rules for each built-in tool
- [Protocol Reference](/reference/protocol) — `tool.approve`, `tool.deny` procedures and the `tool_approval_required` event
