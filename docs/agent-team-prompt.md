# Agent Team Prompt: Testing Infrastructure Refactoring

## Task for the Lead

Improve the testing infrastructure of this monorepo so that:

1. **Tests are trustworthy** — passing tests mean the system works; no false confidence from weak assertions, leaked state, or hidden coupling between test files.
2. **Tests are well-organized** — shared mock patterns live in one place, not copy-pasted across 10+ files; adding a new test requires minimal ceremony.
3. **Integration tests are robust** — e2e flows reliably prove real server-worker-client interactions work, not just that mocks were wired correctly.

The output is a **plan document** at `plans/testing-refactoring-plan.md`. No code changes — only a plan that a follow-up implementation agent can execute. The plan must be concrete: specify exact files to create/modify, what goes in each, and why.

---

## Team Structure

Spawn **5 teammates** with the roles below. Every teammate operates in **plan mode** — they research, analyze, and write plan sections. No file edits except to `plans/testing-refactoring-plan.md`.

### 1. Mock & Harness Architect

**Focus:** Eliminate mock duplication and design reusable test harnesses.

**Research phase — do this first:**
1. Search all `*.test.ts` files for `mock.module(` calls. Map out every module being mocked, in which files, and how the mocks differ between files.
2. Read `packages/test-utils/src/mock-stream.ts` fully — it already exports mock helpers. Understand what's there and why existing tests don't use them (investigate the `mock.module` timing constraint in Bun).
3. Look for duplicated helper functions across test files (stream builders, event collectors, etc.). Count actual instances — don't guess.
4. Read Bun's mock.module docs (https://bun.sh/docs/test/mocks) to understand `--preload`, live bindings, and hoisting behavior.

**Then produce a plan section covering:**
- A harness design that test files can import to set up mocks with zero boilerplate.
- How to handle per-test mutable implementations (the `streamTextImpl` closure pattern).
- Migration path for each affected test file (list them by name, with what changes).
- Whether `--preload` should be used for shared mocks or each test should opt in.

**Constraint:** Do not introduce dependency injection or test-only abstractions into production code. Use `mock.module()` and Bun's native mocking.

### 2. Test Infrastructure & Config Specialist

**Focus:** Test runner configuration, discovery, coverage, and CI setup.

**Research phase — do this first:**
1. Read `package.json` test scripts and `bunfig.toml`. Understand how tests are currently discovered and run.
2. Read Bun's test runner docs (https://bun.sh/docs/cli/test) — understand all `[test]` options in bunfig.toml: `preload`, `timeout`, coverage thresholds, reporter options, `--bail`.
3. Run `bun run test:coverage` and examine the output — what's the current coverage? Which packages are well-covered vs. thin?
4. Check whether any test files set per-test timeouts. Search for timeout values passed to `test()` or `describe()`.
5. Look for state leakage patterns: env vars set in one test affecting another, shared mutable state across describe blocks, missing cleanup in afterAll/afterEach.

**Then produce a plan section covering:**
- Simplify test scripts (the current approach vs. Bun's built-in discovery).
- Recommended `bunfig.toml` settings with justification for each value.
- Whether a global test setup file is needed, and what specifically it should do (based on actual leakage patterns you found, not hypothetical ones).
- CI considerations.

### 3. Test Factories & Builders Designer

**Focus:** Typed factories for test data and shared construction helpers.

**Research phase — do this first:**
1. Read `packages/test-utils/src/` — all files. Understand every exported helper and its API.
2. Search test files for inline object construction of protocol types (`SessionMessage`, `AgentEvent`, `WorkerRegistration`, etc.). Find where tests build these by hand vs. using helpers.
3. Look for local factory functions in test files (e.g., `makeWorker()`, `createClient()`, message builders). Check if they're duplicated or unique.
4. Read `packages/protocol/src/` type definitions to understand the shapes tests need to construct.
5. Examine `createEnvGuard()` usage patterns — are there cases where `restore()` is missed or called in the wrong place?
6. Check `packages/e2e/helpers/` — read every file. Understand what's already shared vs. what's being duplicated in test files.

**Then produce a plan section covering:**
- Which factory functions are worth creating (only where 3+ test files construct the same type inline — don't create factories for one-off usage).
- Where they should live and what their API should look like.
- Whether `createEnvGuard()` needs improvement (based on actual misuse patterns you found).
- Which locally-defined helpers should be promoted to shared modules.

### 4. Integration Test Analyst

**Focus:** Strengthen e2e tests so they prove real system behavior.

**Research phase — do this first:**
1. Read **every file** in `packages/e2e/tests/integration/` and `packages/e2e/helpers/`. Understand what each integration test exercises.
2. Read `packages/e2e/tests/live/` — understand what the live tests cover that integration tests don't.
3. Map the mock boundary: for each integration test, trace what's real (server, worker, WebSocket, tRPC) vs. what's mocked (LLM responses). Understand whether the test is actually testing system integration or just mocks.
4. Read each test's assertions carefully. Flag any test where: (a) assertions only check that a mock was called, not that the system produced the right result; (b) assertions are so loose they'd pass even if the feature was broken; (c) there's no assertion at all (just "didn't throw").
5. Read `docs/server-architecture.md` to understand the full system flow. Compare it against what integration tests cover — what important paths have no test?
6. Look for timing-dependent patterns: `sleep()` calls, hardcoded delays, race conditions in event collection.

**Then produce a plan section covering:**
- Coverage gaps: which system flows have no integration test? (cite the architecture doc)
- Weak assertions: list specific tests and what's wrong with their assertions.
- Reliability risks: specific timing dependencies or race conditions you found.
- Structural improvements: tests that should be split, merged, or rewritten.
- Whether naming conventions (`.e2e.test.ts`) would help or just add churn.

### 5. Devil's Advocate (Reviewer)

**Focus:** Challenge every decision made by the other 4 teammates.

You have **soft veto power**: you can request revision of specific plan sections before they're marked complete. Your concerns must be addressed (even if the resolution is "acknowledged but proceeding anyway with justification").

**Research phase — do this first:**
1. Read `CLAUDE.md` — internalize the design principles. These are your primary evaluation criteria.
2. Read `docs/testing-improvements.md` — understand the prior analysis. Check whether its claims are accurate by spot-checking specific files it references.
3. Independently read 3-4 test files from different packages to build your own sense of the current state. Don't rely only on what other teammates report.
4. Read `packages/test-utils/src/` to understand the existing shared code surface area.

**Then, for each plan section produced by other teammates, evaluate:**
- **Is this solving a real problem or an imagined one?** Verify the teammate's claims by reading the actual files. If the problem only affects 1-2 files, the fix may not justify the abstraction.
- **Does this violate the project's design principles?** (CLAUDE.md: no test-only abstractions in production code, one implementation = no interface, don't propagate options you don't use, solve the actual problem not the general case.)
- **Does this introduce more complexity than it removes?** A 3-line copy-paste might be better than a 50-line harness module. Estimate lines before and after.
- **Will the next developer understand this?** If you need to read 3 files to understand one test, the abstraction has failed.
- **Are there simpler alternatives?** e.g., could Bun's `--preload` solve the mock duplication without any harness code?

Write your review as a separate section at the end of the plan document. Flag specific concerns with `[CONCERN]` tags and rate each as: `[BLOCKING]` (must be resolved) or `[ADVISORY]` (should be considered).

---

## Coordination Rules

1. **Research first, plan second.** Every teammate must read the actual test files and understand the current patterns before proposing changes. Don't plan based on assumptions.
2. **Reference real files.** Every claim ("this pattern is duplicated in N files") must cite specific file paths.
3. **The plan is for an implementation agent.** Write plan sections that another Claude Code session can follow without needing to re-research. Include: which files to create, which files to modify, what the before/after looks like.
4. **One consolidated document.** All teammates contribute sections to `plans/testing-refactoring-plan.md`. The lead synthesizes the final version after Devil's Advocate review.
5. **Devil's Advocate reviews all sections.** No section is final until the Devil's Advocate has reviewed it. Other teammates must respond to `[BLOCKING]` concerns.
6. **Don't over-engineer.** The project's CLAUDE.md explicitly says: "solve the actual problem, not a general case." Keep solutions minimal.

---

## Key Context

- **Runtime:** Bun (not Node). Test runner is `bun:test` (not Jest or Vitest).
- **Mocking:** `mock.module()` from `bun:test`. Module mocks must run before imports. `mock.module()` supports live binding updates.
- **Monorepo:** Bun workspaces. All packages live under `packages/`.
- **Shared test code already exists** in `packages/test-utils/src/` and `packages/e2e/helpers/` — read these before proposing new utilities. Don't duplicate what's already there.
- **Architecture docs:** `docs/server-architecture.md` describes the full system. `CLAUDE.md` has project conventions and design principles.
- **Reference report:** `docs/testing-improvements.md` — prior analysis with improvement ideas. Use as inspiration, not as a spec. Verify its claims independently.
- **Bun test docs:** https://bun.sh/docs/cli/test and https://bun.sh/docs/test/mocks

---

## Output

A single file: `plans/testing-refactoring-plan.md` with these sections:

1. **Mock & Harness Plan** (from teammate 1)
2. **Test Infrastructure & Config Plan** (from teammate 2)
3. **Test Factories & Builders Plan** (from teammate 3)
4. **Integration Test Improvements Plan** (from teammate 4)
5. **Devil's Advocate Review** (from teammate 5)
6. **Resolution Log** — how each `[BLOCKING]` concern was resolved
