# Skills

Skills are Markdown files that provide task-specific instructions to the agent. They let you extend a worker's knowledge without writing code — drop a file in the right place and the worker picks it up automatically.

## How Skills Work

Skills are **loaded lazily**. The server does not inject all skill content into every system prompt. Instead, it exposes a server-local `skill` tool that the LLM calls when it needs instructions for a specific task. The system prompt includes a hint:

> "You have a 'skill' tool available. Use it to load detailed instructions for specialized tasks."

This avoids paying token cost for unused skills — the LLM only loads what it needs, when it needs it.

> **Tip:** Loaded skill content is protected from context pruning. Even when aggressive context pruning is active, tool results from the `skill` tool are never removed, ensuring that skill instructions remain available throughout the session.

## SKILL.md Format

Place skill files at `{workdir}/.agents/skills/{skill-name}/SKILL.md` (preferred) or `{workdir}/.claude/skills/{skill-name}/SKILL.md` (fallback). Each skill lives in its own directory.

```markdown
---
name: deploy
description: Deploy the application to production
---

## Instructions

When asked to deploy, follow these steps:
1. Run the test suite: `bun run test`
2. Build the project: `bun run build`
3. Deploy via: `./scripts/deploy.sh`
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Skill name. Falls back to the directory name if omitted. |
| `description` | No | One-line summary shown to the LLM when listing available skills. |

The body (everything after the closing `---`) becomes the skill content returned when the LLM calls `skill({ name: "deploy" })`.

## AGENTS.md

`AGENTS.md` at the workdir root provides project-level instructions that are included in **every** system prompt for sessions bound to this worker. If `AGENTS.md` is not found, the worker falls back to `CLAUDE.md`.

Use it for project context that should always be available: coding conventions, project structure, preferred tools, architecture notes.

```markdown
# Project Instructions

This is a TypeScript monorepo using Bun.
- Use `bun test` to run tests
- Follow the existing code style
- All new code must have test coverage
```

### AGENTS.md vs Skills

| | AGENTS.md | Skills |
|---|-----------|--------|
| **Loading** | Always included in the system prompt | Loaded on demand when the LLM calls the `skill` tool |
| **Use for** | Project-wide context, conventions, structure | Task-specific instructions (deploy, review, etc.) |
| **Token cost** | Paid on every turn | Only when the skill is invoked |
| **Location** | `{workdir}/AGENTS.md` | `{workdir}/.agents/skills/{name}/SKILL.md` |

### Nested Instruction Discovery

In addition to the root-level AGENTS.md, the system supports nested instruction files in subdirectories. When the LLM reads a file via `read_file`, the worker automatically scans parent directories between the file's location and the workdir for AGENTS.md or CLAUDE.md files. Discovered instructions are injected into the tool output, ensuring that subdirectory-specific project instructions are surfaced automatically.

For example, if a worker's workdir is `/project` and the LLM reads `/project/packages/api/src/main.ts`, the system checks for instruction files in `/project/packages/api/src/`, `/project/packages/api/`, and `/project/packages/` (the root `/project/AGENTS.md` is already loaded via the standard mechanism).

## Skill Registration Flow

1. On startup, the worker scans `{workdir}/.agents/skills/` (or `{workdir}/.claude/skills/` as fallback) for directories containing a `SKILL.md` file.
2. Each `SKILL.md` is parsed: YAML frontmatter extracts `name` and `description`, the Markdown body becomes `content`.
3. The worker reports all discovered skills to the server during `worker.register`, alongside its tools and metadata.
4. The server builds a `skill` tool that accepts a skill name and returns the corresponding content to the LLM.

Skills are reported at connection time and **automatically synced when changed**. The worker watches the skills directory for file changes and pushes updates to the server within seconds — no restart needed.

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
   - Security issues (injection, XSS, etc.)
   - Style consistency with the existing codebase
3. Provide specific, actionable feedback with file paths and line references
4. Suggest fixes where applicable
```

### 3. Verify the skill is loaded

The worker automatically detects new and modified skills. Within a few seconds of saving the file, you should see a log message confirming the skill was synced to the server. No restart is needed.

### Tips

- Keep the `description` concise — the LLM sees it when deciding whether to load the skill.
- Put detailed instructions in the body. This is the content returned to the LLM, so be thorough.
- One skill per directory. The directory name is used as the fallback skill name.

## See Also

- [Worker Overview](/worker/overview) — running a worker, identity, reconnection, workdir layout
- [Built-in Tools](/worker/tools) — the six tools available alongside skills
- [Contributing](/reference/contributing) — adding skills requires no code changes
- [Subagents](/server/subagents) — agent definitions use a similar `.agents/` directory convention
