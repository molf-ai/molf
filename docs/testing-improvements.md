# Testing Infrastructure Improvements

Based on comparative analysis with openclaw, opencode, picoclaw, moltis, and nanobot reference projects.

## Priority 1: High Impact

### 1.1 Extract Reusable Test Harnesses

**Problem:** AI SDK mocking (`mock.module("ai", ...)`) is copy-pasted across 10+ test files with identical boilerplate. Each file re-declares `let streamTextImpl`, re-mocks `@ai-sdk/google`, and uses `any` types throughout.

**Solution:** Create `.test-harness.ts` files that export mock setup, hook installation, and module import helpers.

**Example target API:**
```typescript
// packages/agent-core/tests/harness/ai-sdk.test-harness.ts
import { mock } from "bun:test";

let streamTextImpl: (...args: unknown[]) => unknown;
let lastGoogleConfig: unknown;

mock.module("ai", () => ({
  streamText: (...args: unknown[]) => streamTextImpl(...args),
  tool: (def: unknown) => def,
  jsonSchema: (s: unknown) => s,
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (config: unknown) => {
    lastGoogleConfig = config;
    return () => "mock-model";
  },
}));

export function setStreamTextImpl(impl: (...args: unknown[]) => unknown) {
  streamTextImpl = impl;
}

export function getLastGoogleConfig() {
  return lastGoogleConfig;
}

export function installAiSdkTestHooks() {
  // Reset state between tests
}
```

**Files affected:** `agent.test.ts`, `agent-tool-loop.test.ts`, `agent-abort.test.ts`, `agent-doom-loop.test.ts`, `agent-events.test.ts`, `agent-pruning.test.ts`, `agent-flow.test.ts`, `context-pruning.test.ts`, and all other files that mock the AI SDK.

**Reference:** openclaw's `send.test-harness.ts` pattern with `getTelegramSendTestMocks()` + `installTelegramSendTestHooks()` + `importTelegramSendModule()`.

---

### 1.2 Glob-Based Test Discovery

**Problem:** All test scripts explicitly list every package directory. Adding a new package requires editing 7 scripts in `package.json`.

**Current:**
```json
"test": "bun test packages/protocol/tests/ packages/agent-core/tests/ packages/server/tests/ packages/worker/tests/ packages/client-tui/tests/ packages/client-telegram/tests/ packages/e2e/tests/integration/"
```

**Solution:** Use glob patterns or a test runner config file. Options:
- A) Switch test scripts to use Bun's `--preload` + pattern matching
- B) Add a `bunfig.toml` test include pattern
- C) Create a thin test runner script (like openclaw's `scripts/test-parallel.mjs`)

**Target:**
```json
"test:unit": "bun test packages/*/tests/**/*.test.ts --exclude '**/e2e/**' --exclude '**/*.live.test.ts'",
"test:e2e": "bun test packages/e2e/tests/integration/",
"test:live": "bun test packages/e2e/tests/live/"
```

**Reference:** openclaw uses 6 dedicated vitest config files with explicit include/exclude patterns.

---

### 1.3 Coverage Thresholds

**Problem:** No coverage thresholds configured. Coverage can regress silently.

**Solution:** Add thresholds to `bunfig.toml`:
```toml
[test]
coverageSkipTestFiles = true
coveragePathIgnorePatterns = [
  "packages/test-utils/**",
  "packages/e2e/helpers/**",
]
coverageThreshold = { line = 65, function = 65 }
```

Start with achievable thresholds (65%) and ratchet up as coverage improves. Exclude integration surfaces that are validated by e2e tests.

**Reference:** openclaw uses 70% lines/functions, 55% branches with extensive exclusion lists categorized by reason (entrypoints, interactive UI, hard-to-unit-test modules).

---

## Priority 2: Medium Impact

### 2.1 Typed Mock Factories

**Problem:** Most mock code uses `any` types, losing type safety:
```typescript
let streamTextImpl: (...args: any[]) => any;  // no type checking
const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
```

**Solution:** Create typed factory functions in `packages/test-utils/`:
```typescript
// packages/test-utils/src/mock-factories.ts
import type { StreamEvent } from "./mock-stream.js";
import type { LLMConfig } from "@molf-ai/protocol";

export function createTestLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: "gemini",
    model: "test-model",
    apiKey: "test-key",
    ...overrides,
  };
}

export function createTestAgentConfig(overrides?: Partial<AgentConfig>) {
  return {
    llm: createTestLLMConfig(),
    ...overrides,
  };
}
```

**Reference:** openclaw's `makePermissionRequest()` and `makeAttemptResult()` factories with `Partial<T>` override support.

---

### 2.2 Scoped Environment Utilities

**Problem:** `createEnvGuard()` requires manual `restore()` calls. Forgetting to call `restore()` leaks env vars.

**Solution:** Add scoped alternatives alongside existing utilities:
```typescript
// packages/test-utils/src/env-guard.ts (additions)

export function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const guard = createEnvGuard();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) guard.delete(key);
    else guard.set(key, value);
  }
  try {
    return fn();
  } finally {
    guard.restore();
  }
}

export async function withEnvAsync<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const guard = createEnvGuard();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) guard.delete(key);
    else guard.set(key, value);
  }
  try {
    return await fn();
  } finally {
    guard.restore();
  }
}
```

Keep `createEnvGuard()` for cases where beforeEach/afterEach is preferred.

**Reference:** openclaw's `withEnv()` / `withEnvAsync()` in `src/test-utils/env.ts`.

---

### 2.3 Deterministic Port Allocation

**Problem:** `getFreePort()` uses random OS port allocation. In parallel CI runs, derived ports (e.g. base+1 for secondary services) could collide with another test's primary port.

**Solution:** Allocate deterministic port blocks per test file or worker:
```typescript
// packages/test-utils/src/port.ts (addition)

let blockCounter = 0;
const BLOCK_SIZE = 10;
const BASE_PORT = 30000;

export function getPortBlock(count = 1): number[] {
  const base = BASE_PORT + (blockCounter++ * BLOCK_SIZE);
  return Array.from({ length: count }, (_, i) => base + i);
}
```

For now this is a low-risk improvement since Bun runs tests serially within a file. Becomes important if parallel test execution is enabled.

**Reference:** openclaw's `getDeterministicFreePortBlock()` which calculates ranges based on Vitest worker ID.

---

### 2.4 Test Timeouts Configuration

**Problem:** No explicit test timeouts configured. Hanging tests run indefinitely.

**Solution:** Add to `bunfig.toml`:
```toml
[test]
timeout = 30000        # 30s for unit tests
```

For e2e tests, set per-test timeouts:
```typescript
test("full flow with tool calls", async () => {
  // ...
}, 60_000);
```

**Reference:** openclaw uses 120s test timeout, 180s hook timeout (OS-aware).

---

## Priority 3: Lower Impact / Future

### 3.1 Mock Provider Registry Module

**Problem:** `mockProviderRegistryModule()` in `test-utils` is a large function that returns a class with duplicated logic. Tests that need provider mocking must call this and then `mock.module()` with the result.

**Solution:** Consolidate into a single harness file that handles both the mock definition and module registration:
```typescript
// packages/test-utils/src/provider-harness.ts
import { mock } from "bun:test";

const mockRegistry = { /* ... */ };

mock.module("../src/providers/registry.js", () => ({
  ProviderRegistry: MockProviderRegistry,
  createDefaultRegistry: () => mockRegistry,
}));

export { mockRegistry };
```

---

### 3.2 Test Data Builders for Protocol Types

**Problem:** Tests construct `SessionMessage`, `AgentEvent`, and other protocol types inline with manual field population. Missing fields cause runtime errors rather than compile errors.

**Solution:** Create builders in `packages/test-utils/`:
```typescript
// packages/test-utils/src/builders.ts
import type { SessionMessage, AgentEvent } from "@molf-ai/protocol";

let idCounter = 0;

export function buildUserMessage(content: string, overrides?: Partial<SessionMessage>): SessionMessage {
  return {
    id: `msg-${idCounter++}`,
    role: "user",
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function buildAssistantMessage(content: string, overrides?: Partial<SessionMessage>): SessionMessage {
  return {
    id: `msg-${idCounter++}`,
    role: "assistant",
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function buildToolMessage(
  content: string,
  toolName: string,
  overrides?: Partial<SessionMessage>,
): SessionMessage {
  return {
    id: `msg-${idCounter++}`,
    role: "tool",
    content,
    toolCallId: `tc-${idCounter++}`,
    toolName,
    timestamp: Date.now(),
    ...overrides,
  };
}
```

These already exist inline in `context-pruner.test.ts` — extract and share.

**Reference:** openclaw's `makeAttemptResult()` and `makePermissionRequest()` factories.

---

### 3.3 Global Test Setup File

**Problem:** No global test setup. Each test file independently handles env isolation, mock cleanup, etc.

**Solution:** Add a preload script for common setup:
```typescript
// test/setup.ts
import { afterEach } from "bun:test";

// Guard against leaked env vars (safety net)
const originalEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (process.env[key] !== value) {
      process.env[key] = value;
    }
  }
});
```

Configure in `bunfig.toml`:
```toml
[test]
preload = ["./test/setup.ts"]
```

**Reference:** openclaw's `test/setup.ts` (606 lines) handles env isolation, plugin registry reset, fake timer cleanup, and MaxListeners budgeting.

---

### 3.4 Separate E2E Naming Convention

**Problem:** Unit and e2e test files both use `.test.ts` suffix, distinguished only by directory. This works but makes it harder to run subsets.

**Solution:** Adopt `.e2e.test.ts` suffix for integration tests:
```
packages/e2e/tests/integration/agent-flow.e2e.test.ts
packages/e2e/tests/integration/full-flow.e2e.test.ts
```

This enables pattern-based filtering without directory-based script configuration.

**Reference:** openclaw uses `.test.ts` (unit), `.e2e.test.ts` (integration), `.live.test.ts` (live).

---

## Implementation Order

| Step | Item | Effort | Risk |
|------|------|--------|------|
| 1 | 1.1 Extract test harnesses | Medium | Low (additive, no behavior change) |
| 2 | 1.2 Glob-based test discovery | Small | Low |
| 3 | 1.3 Coverage thresholds | Small | Low |
| 4 | 2.1 Typed mock factories | Medium | Low |
| 5 | 2.2 Scoped env utilities | Small | Low |
| 6 | 2.4 Test timeouts | Small | Low |
| 7 | 3.2 Test data builders | Small | Low |
| 8 | 3.3 Global test setup | Small | Low |
| 9 | 2.3 Deterministic ports | Small | Low (matters for parallel CI) |
| 10 | 3.1 Provider registry harness | Small | Low |
| 11 | 3.4 E2E naming convention | Small | Medium (renames files) |

Steps 1-3 deliver the most value and should be done first. Steps 4-8 are incremental improvements that can be done alongside feature work. Steps 9-11 are future-proofing.
