# Skills

Skills are instruction documents that the LLM can load on demand during a session. They provide task-specific guidance without bloating the system prompt with instructions that may not be relevant.

## How Skills Work

Skills are registered by the worker on startup and reported to the server. The server builds a `skill` tool that lists all available skills with their descriptions. When the LLM decides it needs guidance for a specific task, it calls the `skill` tool with the skill name, and the full content of the SKILL.md file is returned as the tool result.

This lazy-loading approach keeps the base system prompt small while making specialized instructions available when needed. Loaded skill content is protected from context pruning -- even when aggressive pruning is active, `skill` tool results are never removed.

## Skill Files

Skills are defined as Markdown files in the worker's working directory:

```
{workdir}/.agents/skills/{name}/SKILL.md
```

The worker also checks the fallback location:

```
{workdir}/.claude/skills/{name}/SKILL.md
```

The `.agents/skills/` directory is checked first. If it exists, `.claude/skills/` is ignored. Only the first matching directory is used.

### SKILL.md Format

Each skill file uses YAML frontmatter for metadata, followed by the instruction content:

```markdown
---
name: deploy
description: Instructions for deploying the application to production
---

## Deployment Process

1. Run the test suite first
2. Build the application
3. Deploy via the deploy script
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Skill name (defaults to the directory name if omitted) |
| `description` | No | Short description shown to the LLM in the skill tool listing |

The `description` field is important because it helps the LLM decide whether to load the skill. Write descriptions that clearly indicate when the skill is relevant.

If the frontmatter is missing or cannot be parsed, the directory name is used as the skill name and the entire file content becomes the skill body.

### Example Directory Structure

```
.agents/
  skills/
    deploy/
      SKILL.md
    code-review/
      SKILL.md
    testing/
      SKILL.md
```

## AGENTS.md / CLAUDE.md

The root instruction document is always injected into the system prompt, unlike skills which are loaded on demand.

The worker looks for these files at the workdir root, in order:

1. `AGENTS.md` (preferred)
2. `CLAUDE.md` (fallback)

Only the first file found is used. Its content is sent to the server as part of the worker's metadata on registration and included in every system prompt for sessions using that worker.

Use this file for project-wide instructions that should always be available: coding conventions, architecture notes, repository structure, or tool usage guidelines.

### AGENTS.md vs Skills

| | AGENTS.md | Skills |
|---|-----------|--------|
| **Loading** | Always in the system prompt | On demand via the `skill` tool |
| **Use for** | Project-wide context, conventions, structure | Task-specific instructions (deploy, review, etc.) |
| **Token cost** | Paid on every turn | Only when invoked |
| **Location** | `{workdir}/AGENTS.md` | `{workdir}/.agents/skills/{name}/SKILL.md` |
| **Context pruning** | Subject to normal pruning | Protected from pruning |

## Nested Instructions

When the LLM reads a file via `read_file`, the system can discover and inject additional instruction files found in directories between the file's location and the workdir root. This is handled by the `discoverNestedInstructions` function.

The discovery process:

1. Start from the directory containing the read file
2. Walk up the directory tree toward the workdir root (exclusive -- the root AGENTS.md is already loaded via the standard mechanism)
3. At each directory, check for `AGENTS.md` first, then `CLAUDE.md`
4. Only one file per directory is used (`AGENTS.md` wins over `CLAUDE.md`)

This allows different parts of a codebase to carry their own contextual instructions:

```
{workdir}/
  AGENTS.md                         # Root instructions (always in system prompt)
  packages/
    server/
      AGENTS.md                     # Server-specific instructions
    worker/
      AGENTS.md                     # Worker-specific instructions
```

When the LLM reads a file under `packages/server/`, the server-specific `AGENTS.md` is automatically discovered and injected alongside the tool result. Previously injected instructions are tracked per session to avoid duplicates; after context summarization, the tracker resets so instructions can be re-injected.

## The `skill` Tool

The `skill` tool is built server-side (not on the worker) and added to the LLM's tool set when the worker has at least one skill. The tool listing includes all skill names and descriptions:

```xml
<skills>
  <skill name="deploy">Instructions for deploying the application</skill>
  <skill name="code-review">Guidelines for reviewing pull requests</skill>
</skills>
```

The tool accepts a single parameter:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string (enum) | Yes | The skill to load (must match an available skill name) |

Like other tools, `skill` calls go through the [tool approval](/server/tool-approval) system.

## Hot-Reload

The worker watches skill files and the root instruction document for changes using chokidar. When a change is detected:

- Skills are reloaded from disk and synced to the server
- The root instruction document (`AGENTS.md` or `CLAUDE.md`) is re-read and synced
- Changes take effect on the next prompt without restarting the worker

The watcher uses a 500 ms debounce and serialized change handlers to prevent race conditions. If the `.agents/skills/` directory does not exist at startup, the worker polls every 5 seconds until it appears, then starts watching.

## Creating a Skill

### 1. Create the skill directory

```bash
mkdir -p .agents/skills/code-review
```

### 2. Write the SKILL.md file

```markdown
---
name: code-review
description: Review code changes for quality and correctness
---

## Code Review Instructions

When asked to review code:

1. Read the changed files using `read_file`
2. Check for:
   - Logic errors and edge cases
   - Missing error handling
   - Security issues
   - Style consistency with the existing codebase
3. Provide specific, actionable feedback with file paths and line references
```

### 3. Verify the skill is loaded

The worker automatically detects new and modified skills. Within a few seconds of saving the file, you should see a log message confirming the skill was synced to the server. No restart is needed.

**Tips:**

- Keep the `description` concise -- the LLM sees it when deciding whether to load the skill
- Put detailed instructions in the body, which is the content returned to the LLM
- One skill per directory; the directory name is used as the fallback skill name

## See Also

- [Worker Overview](/worker/overview) -- workdir layout and state watching
- [Built-in Tools](/worker/tools) -- the six worker-side tools
- [Subagents](/server/subagents) -- custom agent definitions use a similar `.agents/` directory convention
