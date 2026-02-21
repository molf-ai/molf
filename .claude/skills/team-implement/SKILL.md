---
name: team-implement
description: Spawn an agent team to implement changes from a research draft — strict file ownership, devil's advocate review, fresh-eyes code review loop, full test verification
disable-model-invocation: true
---

# Implement Skill

Spawn an agent team to implement changes based on a research draft produced by `/team-research`. The draft path is passed as an argument (e.g., `/team-implement drafts/topic.md`).

## Step 1 — Analyze the draft and codebase

1. Read the draft file passed as argument
2. Understand findings, recommendations, open questions, and testing requirements
3. Read CLAUDE.md for design principles
4. Skim referenced files to confirm they still match the draft's assumptions
5. If the draft has open questions that affect implementation, resolve them via **AskUserQuestion** before proposing a team

## Step 2 — Propose a team

Design a team with **zero file-ownership overlap** — each teammate owns distinct files and only modifies those files.

Typical roles:
- **Implementers** (one per area) — each owns a set of source files to create or modify
- **Test writer** — owns test files only, writes both unit and integration tests (see testing rules below)
- **Devil's advocate** — owns no files, reviews all changes against CLAUDE.md principles

Present the proposed team via **AskUserQuestion** with file assignments per role. The user can accept, modify, add, or remove roles.

**Strongly recommend including a devil's advocate.** This role catches over-engineering, design principle violations, missed edge cases, and unnecessary abstractions. If the user removes it, respect that, but make the case.

## Step 3 — Implement

Spawn the team. Each teammate gets:
- The full draft text
- Their file assignments (which files they own and may modify)
- The project's design principles from CLAUDE.md
- Instruction to read current code in their assigned files before making changes

### File ownership rules

- Each teammate may only modify files assigned to them
- If a teammate needs a change in another teammate's file, they **message the owner** with the request
- This prevents merge conflicts and ensures each area has a single responsible author

### How teammates work together

- Teammates communicate via **messages** — send proposals, questions, and change requests to each other directly
- The **shared task list** tracks what each teammate is working on and dependencies
- **No intermediate files for coordination.** Use messaging and the task list.

### Devil's advocate role

The devil's advocate reviews implementation quality:
- Wait for teammates to produce initial code, then review
- Message teammates directly with concerns — have a conversation, don't just critique
- Check against CLAUDE.md design principles: no over-engineering, no leaky abstractions, no test-only mocks in production code, solve the actual problem
- Look for: unnecessary abstractions, missing edge cases, violated conventions, code that doesn't match the draft's intent
- Has soft veto power — can request teammates revise specific parts before the work is considered done

## Step 4 — Verify

After all teammates have finished (and the devil's advocate is satisfied), run verification:

1. **Type check** affected packages: `bunx tsc --noEmit -p packages/{pkg}/tsconfig.json` for each affected package
2. **Unit tests**: `bun run test`
3. **Integration tests**: `bun run test:e2e`
4. All tests must pass, including new ones written by the test writer
5. If any check fails, fix the failures before completing — route fixes to the teammate who owns the failing files

## Step 5 — Fresh-eyes code review

After Step 4 passes (all types check, all tests pass), spawn a **new reviewer teammate** with clean context. This teammate must have **no prior involvement** in the implementation — their only input is:
- The original draft file path
- The list of changed files (paths only)
- CLAUDE.md (for project design principles)

The reviewer's job:
- Read every changed file from disk
- Read the draft to understand the intended design
- Produce a numbered list of **concrete issues** — not style nits, but real problems:
  - Code that doesn't match the draft's intent or skips parts of the design
  - CLAUDE.md principle violations (over-engineering, leaky abstractions, unnecessary interfaces, test-only mocks in production)
  - Missing edge case handling that the draft explicitly called out
  - Tests that don't actually verify the behavior they claim to test (e.g., asserting on mocks instead of real behavior)
  - Dead code, unused imports, or leftover scaffolding
  - Inconsistencies between changed files (e.g., a type defined one way but used differently)
- The reviewer does **not** rewrite code — they only flag issues with file paths and line references

When the reviewer finishes, **broadcast their findings to all original teammates** and assign each teammate the issues in their owned files.

### Fix → challenge → verify cycle

1. Teammates fix the reviewer's issues in their owned files
2. The **devil's advocate challenges every proposed fix** — independently reads the fix, verifies it actually solves the issue without introducing new problems, checks it still aligns with CLAUDE.md principles. Messages teammates directly to debate, just like during the original implementation.
3. Once the devil's advocate is satisfied, the lead re-runs verification:
   - `bunx tsc --noEmit -p packages/{pkg}/tsconfig.json` for affected packages
   - `bun run test`
   - `bun run test:e2e`
4. If verification fails, route failures to the owning teammate and repeat from step 1

### Review loop

After verification passes, the **reviewer reads the updated files again** and produces a new verdict:
- **"Excellent"** or **"only minor issues remain"** → done, move to Step 6
- **Concrete issues remain** → repeat the fix-challenge-verify cycle above

Continue until the reviewer's verdict is "excellent" or "only minor issues." The reviewer must give an explicit verdict each round — not just a list of issues.

**Safety valve:** if the review has not converged after **3 rounds**, stop and include the remaining open issues in the summary as a clearly marked "Unresolved from review" section. Do not loop forever.

## Step 6 — Finalize

Run a final verification to confirm everything is clean:
1. `bunx tsc --noEmit -p packages/{pkg}/tsconfig.json` for all affected packages
2. `bun run test`
3. `bun run test:e2e`

## After completion

Provide a summary:
- Files changed (with paths)
- What the devil's advocate challenged and how it was resolved
- Fresh-eyes review: number of rounds, key issues caught and how they were fixed
- Any unresolved items (if the safety valve triggered)
- Test results (unit + integration)
- Key decisions made during implementation
- Anything deferred or left for future work
