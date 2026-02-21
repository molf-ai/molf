---
name: team-research
description: Spawn an agent team to research a topic and produce an actionable draft — includes devil's advocate and a fresh-eyes review pass
disable-model-invocation: true
---


# Research Skill

Spawn an agent team to research a topic and produce an actionable draft. The output should be usable as an implementation prompt in a follow-up session.

## Step 1 — Analyze the task and codebase

Before proposing a team, understand what's needed:

1. Read the user's request — what do they need to learn, decide, or build?
2. Skim the relevant parts of the codebase (if the task involves this project)
3. Read CLAUDE.md to understand the project's design principles
4. Identify the key angles that need investigation

## Step 2 — Propose a team

Based on your analysis, design a team tailored to this specific task. Each teammate should cover a distinct angle — avoid overlap. The team should cover both research and planning — don't separate them.

Use **AskUserQuestion** to present the proposed team: list each role with a one-line description of what they'll focus on.

**Strongly recommend including a devil's advocate.** This role challenges findings and proposals, catches blind spots and over-engineering, and makes the output more robust. If the user removes it, respect that, but make the case.

The user can accept, modify, add, or remove roles.

## Step 3 — Create the agent team

Spawn the team. Each teammate gets:
- Their specific focus area
- The full context of the task and why it matters
- Instructions to read actual code/docs before forming opinions — cite file paths for every claim

### How teammates work together

- Teammates communicate via **messages** — send findings, proposals, and questions to each other directly
- The **shared task list** tracks what each teammate is working on and dependencies
- The devil's advocate messages other teammates to challenge their work — teammates respond and either defend or revise
- **No intermediate files for coordination.** Use messaging and the task list.

### Devil's advocate role

The devil's advocate makes the output stronger:
- Wait for other teammates to produce work, then challenge it
- Message teammates directly — have a conversation, don't just critique in isolation
- Independently verify claims by reading the actual code/sources
- Look for: confirmation bias, missing alternatives, unstated assumptions, over-engineering
- **Walk through every scenario**, not just the happy path — what happens on failure, restart, cold start, partial state, concurrent access? If the proposal only describes the sunny-day flow, it's incomplete.
- Has soft veto power — can request teammates revisit specific parts before the work is considered done

## Step 4 — Compile the draft

After all teammates have finished (and the devil's advocate is satisfied), compile the final draft as team lead.

Write to `drafts/{topic-slug}.md` in the project root.

The draft should contain everything a follow-up implementation session needs:
- What was learned (findings, with citations to files/URLs)
- What should be done (recommendations, approach, concrete steps)
- What was challenged by the devil's advocate and how it was resolved
- What's still open (unresolved questions, decisions for the implementer)
- **What tests to write** — the draft must include a concrete testing section:
  - Unit test scenarios for new/changed functions (what to assert, edge cases)
  - Integration test scenarios (how components interact end-to-end)
  - Which existing test patterns to follow (reference specific test files as examples)

**Before finalizing, walk through the proposed design end-to-end.** Trace every user-facing scenario from start to finish — including startup, restarts, error recovery, and edge cases. If any scenario reveals a gap (e.g., state that's lost between restarts, flows that assume a warm cache), fix the design before writing the draft. The draft must describe a complete feature, not just the main flow.

Don't force a rigid structure — let the content dictate the format. A comparative analysis looks different from a feature plan looks different from a bug investigation.

## Step 5 — Fresh-eyes review

After the draft is written to disk, spawn a **new reviewer teammate** with clean context. This teammate must have **no prior involvement** in the research — their only input is:
- The draft file path
- The original user request (one sentence)
- CLAUDE.md (for project context)

The reviewer's job:
- Read the draft from scratch, as if they're the implementer receiving it
- Produce a numbered list of **concrete issues** — not vague "could be better" feedback, but specific problems:
  - Steps that are ambiguous or missing details (what file? what function signature? what error case?)
  - Contradictions between sections
  - Recommendations that aren't grounded in cited code/evidence
  - Missing edge cases or failure scenarios
  - Testing section that doesn't cover the described behavior
  - Circular reasoning or hand-waving ("consider doing X" without saying how)
- The reviewer does **not** redo the research — they only evaluate what's written

When the reviewer finishes, **broadcast their findings to all original teammates** and assign each teammate the issues in their area.

### Fix → challenge → update cycle

1. Teammates address the reviewer's issues in their areas
2. The **devil's advocate challenges every proposed fix** — not rubber-stamping, but independently verifying each amendment makes sense, doesn't introduce new problems, and is actually grounded in evidence. The devil's advocate messages teammates directly to debate fixes, just like during the original research.
3. Once the devil's advocate is satisfied with the fixes, the lead updates the draft on disk

### Review loop

After the draft is updated, the **reviewer reads the updated draft again** and produces a new verdict:
- **"Excellent"** or **"only minor issues remain"** → done, move to Step 6
- **Concrete issues remain** → repeat the fix-challenge-update cycle above

Continue until the reviewer's verdict is "excellent" or "only minor issues." The reviewer must give an explicit verdict each round — not just a list of issues.

**Safety valve:** if the review has not converged after **3 rounds**, stop and include the remaining open issues in the draft as a clearly marked "Unresolved from review" section. Do not loop forever.

## Step 6 — Finalize the draft

Update the draft file with all fixes from the review rounds. Add a short section at the end:

> ### Review notes
> - Number of review rounds
> - Key issues caught and how they were resolved
> - Any unresolved items (if the safety valve triggered)

This section helps the implementer understand what was already stress-tested.

## After completion

Tell the user:
1. Where the draft is saved
2. Brief summary of findings and recommendations
3. What the fresh-eyes review caught and fixed
4. Suggest: "Start a new session and use the draft as your implementation prompt"
