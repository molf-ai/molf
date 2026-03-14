---
name: team-actualize-docs
description: Run a multi-agent team to update existing project documentation — reads current docs first, then patches only what changed
disable-model-invocation: true
---

# Actualize Docs Skill

Use this skill when asked to update, actualize, or improve project documentation.

## What it does

Runs a 7-agent team across 4 sequential phases. **Agents always read existing docs before writing** — the goal is to patch what changed, not rewrite what's already good.

- **Phase 1:** `codebase-researcher` reads all source packages AND existing docs, produces a codebase report and an inventory of what's stale
- **Phase 2:** `structure-planner` compares the inventory against current codebase — proposes only the changes needed (new pages, moved sections, outdated content)
- **Phase 3 (parallel):** `server-writer`, `worker-writer`, `clients-writer`, `protocol-writer` each read their assigned existing pages first, then update only what's stale or missing
- **Phase 4:** `readability-reviewer` does a final pass for consistency, cross-links, and clarity

## Update vs rewrite

Writers must follow this rule: **edit existing content, don't replace it**. Specifically:

- If a page exists and is accurate → leave it alone
- If a page exists but has stale details (old flags, missing features, wrong defaults) → edit only those sections
- If a page exists but is missing entire sections → add them
- If a page doesn't exist yet → write it from scratch
- If a page is no longer needed → flag it to team-lead, don't delete unilaterally

## Key design principles (enforce these)

- Clear top-level separation: **Server / Worker / Clients** — never mix them
- Clients section always has **separate pages** for each client (TUI, Telegram, custom)
- One server is the central hub — clients and workers never talk to each other directly
- Content and structure only — **no CSS, no theme, no `.vitepress` style files**
- Every technical detail sourced from actual code — exact flag names, defaults, env vars

## Intermediate files (written to /tmp/claude-1000/)

| File | Written by | Used by |
|------|-----------|---------|
| `docs-research-codebase.md` | codebase-researcher | structure-planner, all writers |
| `docs-existing-inventory.md` | codebase-researcher | structure-planner, all writers |
| `docs-structure-plan.md` | structure-planner | all writers, reviewer |
| `docs-review-summary.md` | readability-reviewer | team-lead summary |

`docs-existing-inventory.md` lists every existing doc page with a one-line note on whether it's accurate, stale, or missing coverage — giving the structure-planner and writers a clear diff to work from.

## Codebase researcher responsibilities

In addition to reading all source packages, the codebase-researcher must:

1. Read every existing doc page under `docs/`
2. For each page, note: is the content accurate? what's stale? what's missing?
3. Write this as `docs-existing-inventory.md` — one row per page:

```
| Page | Status | Notes |
|------|--------|-------|
| server/overview.md | accurate | — |
| worker/tools.md | stale | shell_exec timeout changed from 60s to 120s |
| clients/telegram.md | missing | no coverage of media groups |
| reference/troubleshooting.md | new needed | does not exist yet |
```

## Structure planner requirements

Output `/tmp/claude-1000/docs-structure-plan.md` with:
1. Change summary: which pages need updates, which are new, which are fine
2. For pages needing updates: list only the specific H2 sections to change
3. For new pages: full H2-level outline
4. Any sidebar/nav changes needed (only if structure has changed)
5. Files to delete / redirect (only if a page is genuinely obsolete)

## Writer assignments (adjust if structure changes)

| Agent | Files |
|-------|-------|
| server-writer | `config.mts`, `index.md`, `guide/getting-started.md`, `guide/configuration.md`, `server/overview.md`, `server/sessions.md` |
| worker-writer | `worker/overview.md`, `worker/tools.md`, `worker/skills.md` |
| clients-writer | `clients/terminal-tui.md`, `clients/telegram.md`, `clients/custom-client.md` |
| protocol-writer | `reference/architecture.md`, `reference/protocol.md`, `reference/testing.md`, `reference/contributing.md`, `reference/troubleshooting.md` |

## Reviewer checklist

- Intro paragraph on every page (1–2 sentences)
- Consistent terminology: "session" not "conversation", "oRPC procedure" not "endpoint", "tool call" not "function call", "worker" not "agent" for the worker process
- Cross-links between related pages ("See also" sections)
- getting-started.md links to all component pages
- No content added that isn't backed by codebase research

## Task dependency graph

```
[1] codebase-researcher  (reads source + existing docs → inventory)
         │
         ▼
[2] structure-planner ─┬─► [3] server-writer ─┐
                       ├─► [4] worker-writer  ├─► [7] reviewer
                       ├─► [5] clients-writer │
                       └─► [6] protocol-writer┘
```

## When to remove legacy routes

After writing is done, delete any old files that were replaced (e.g. moved pages). Ask the user before deleting if uncertain.

## First run vs subsequent runs

- **First run (no existing docs):** writers create all pages from scratch using codebase research
- **Subsequent runs (docs exist):** writers read existing pages first, then apply targeted edits based on the inventory and structure plan — rewriting only what's stale or incomplete
