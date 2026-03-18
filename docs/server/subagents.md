# Subagents

## Overview

The agent can spawn isolated child agents ("subagents") via the `task` tool for parallel or specialized subtasks. Each subagent runs in its own session with scoped permissions and tools. Results return to the parent as tool results.

Key properties:

- **Same worker** — subagents use the same worker as the parent session
- **Own child session** — each subagent gets a dedicated session with `metadata.subagent` linking it to the parent
- **No nesting** — subagents cannot spawn their own subagents (the `task` tool is denied inside child sessions)
- **5-minute timeout** — subagents have a hard 5-minute timeout
- **Parent abort propagation** — aborting the parent session also aborts any running subagents
- **Parallel execution** — the LLM can call `task` multiple times in one turn to run subagents in parallel

## Built-in Agents

Two default agents are always available, even without custom agent files:

| Name | Description | Permissions | Max Steps |
|------|-------------|-------------|-----------|
| `explore` | Fast agent for exploring the codebase. Read-only. | `*: deny`, `grep: allow`, `glob: allow`, `read_file: allow`, `web_fetch: allow`, `web_search: allow` | 15 |
| `general` | General-purpose agent for multi-step tasks. Full tool access. | `*: allow` | 20 |

## The `task` Tool

When agent definitions are available (built-in or custom), the server automatically adds a `task` tool to the session's tool set. If no agents are available, the tool is omitted.

**Input schema:**

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Brief description of the subtask (shown to users) |
| `prompt` | string | The full prompt for the subagent |
| `agentType` | string (enum) | One of the available agent names (e.g. `"explore"`, `"general"`) |

The `agentType` field is an enum whose values are the names of all resolved agents for the current session's worker.

## Defining Custom Agents

### File Location

Workers load agent definitions from Markdown files in one of two directories, checked in order:

1. `{workdir}/.agents/agents/*.md` (preferred)
2. `{workdir}/.claude/agents/*.md` (fallback)

The first existing directory wins. Non-`.md` files are ignored.

### File Format

Agent files use YAML frontmatter followed by a Markdown body. The body becomes the subagent's system prompt suffix.

```markdown
---
name: reviewer
description: Code review agent
permission:
  "*": deny
  grep: allow
  read_file:
    "*": allow
    "*.env": deny
maxSteps: 5
---
You are a code reviewer. Read files and provide feedback.
```

### Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | No | Filename without `.md` | Agent name |
| `description` | **Yes** | — | One-line description (agents without this are skipped) |
| `permission` | No | `{ "*": "allow" }` | CompactPermission config |
| `maxSteps` | No | `10` | Max tool-use steps |

### Permission Format

The `permission` field uses the `CompactPermission` format — a YAML mapping of tool names to actions:

```yaml
permission:
  "*": deny           # deny everything by default
  grep: allow          # allow grep
  read_file:
    "*": allow         # allow reading most files
    "*.env": deny      # deny reading .env files
```

Actions are `allow`, `deny`, or `ask`. Patterns use the same [picomatch](https://github.com/micromatch/picomatch) globbing as `permissions.jsonc` (see [Tool Approval > Pattern Matching](/server/tool-approval#pattern-matching)).

### Resolution

The server merges built-in defaults with worker-provided agents:

1. Start with defaults (`explore`, `general`)
2. Worker agents with the **same name** replace the corresponding default
3. Worker agents with **new names** are added
4. A `task: deny` rule is appended to every agent's permission ruleset (prevents nesting)

### Hot-Reload

Agent files are watched by the worker's state watcher. Adding, modifying, or removing `.md` files triggers a reload and sync to the server. Changes are picked up on the next session prompt.

## Subagent Permissions

Subagent sessions use a 3-layer permission model:

1. **Agent permission** (base layer) — from the agent type definition. Defines which tools the subagent type can use. **Agent deny rules act as a veto and cannot be overridden.**
2. **Static rules** (server layer) — from `permissions.jsonc` on disk.
3. **Runtime "always approve"** (user layer) — session-scoped rules added when a user selects "Always Approve."

Agent "deny" results are final — static and runtime layers cannot weaken them. Agent "allow" and "ask" results use last-match-wins semantics across all three layers, so later layers can tighten or loosen them.

See [Tool Approval > Subagent Permissions](/server/tool-approval#subagent-permissions) for details and examples.

## Event Forwarding

All events from a subagent are forwarded to the parent session's ServerBus wrapped in a `subagent_event` envelope:

```typescript
{
  type: "subagent_event",
  agentType: "explore",
  sessionId: "child-session-uuid",
  event: { /* any BaseAgentEvent */ }
}
```

Key behaviors:

- Clients receive subagent events on the parent's `agent.onEvents` subscription
- `tool_approval_required` events from subagents are forwarded and handled identically to direct approval events
- `turn_complete` on the parent clears subagent display state

## Result Format

Successful subagent execution returns the subagent's text response wrapped in XML:

```
<task_result agent="explore">
The subagent's text response.
</task_result>
```

Errors return similarly:

```
<task_error agent="explore">
Error message.
</task_error>
```

## See Also

- [Tool Approval](/server/tool-approval) — approval rules, evaluation order, and subagent permission layer
- [Worker Overview](/worker/overview) — agent file loading and workdir layout
- [Built-in Tools](/worker/tools) — the `task` tool in the tool composition table
- [Protocol Reference](/reference/protocol) — `SubagentEvent`, `WorkerAgentInfo`, `CompactPermission` types
- [Sessions](/server/sessions) — child session creation and lifecycle
