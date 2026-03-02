# Testing

Molf uses Bun's built-in test runner (`bun:test`). All new code must be covered by tests.

## Test Tiers

| Tier | Location | What It Tests | Command |
|------|----------|---------------|---------|
| **Unit** | `packages/{pkg}/tests/` | Individual modules in isolation (mocked deps) | `bun run test:unit` |
| **Integration** | `packages/e2e/tests/integration/` | Full server + worker + client flows with mocked LLM | `bun run test:e2e` |
| **Live / Smoke** | `packages/e2e/tests/live/` | Real Gemini API calls (text generation + tool use) | `bun run test:live` |

**Aggregate commands:**

| Command | What It Runs |
|---------|-------------|
| `bun run test` | Unit + Integration (no live) |
| `bun run test:all` | Unit + Integration + Live |
| `bun run test:ci` | Unit + Integration, bail on first failure |
| `bun run test:coverage` | Unit + Integration with coverage report |

Live tests require `GEMINI_API_KEY` env var and `MOLF_LIVE_TEST=1`.

## Test Utilities (`packages/test-utils/`)

Shared helpers available to all test files.

### LLM Mocking

Mock the Vercel AI SDK's `streamText` and `generateText` to simulate LLM responses without hitting a real API:

```typescript
import { mockStreamText, mockTextResponse, mockToolCallResponse } from "@molf-ai/test-utils";

// Mock a simple text response
const mockStream = mockTextResponse("Hello, I can help with that!");

// Mock a text response with token usage data
const mockWithUsage = mockTextResponse("Hello!", {
  inputTokens: 100, outputTokens: 20, totalTokens: 120,
});

// Mock a tool call followed by a text response
const mockTool = mockToolCallResponse(
  "shell_exec",
  { command: "ls" },
  { stdout: "file1.txt\nfile2.txt", stderr: "", exitCode: 0 },
);
```

All mock functions accept an optional `usage` parameter of type `{ inputTokens: number; outputTokens: number; totalTokens: number }` to simulate token usage data on LLM responses.

#### Non-streaming LLM Mocking

For testing non-streaming `generateText()` calls (used by summarization and other non-streaming LLM interactions), use `setGenerateTextImpl` from the AI mock harness:

```typescript
import { setGenerateTextImpl } from "@molf-ai/test-utils/ai-mock-harness";

setGenerateTextImpl(async () => ({ text: "Summary of conversation..." }));
```

The default implementation returns `{ text: "" }`. Reset in `afterEach` if needed.

### Infrastructure Helpers

```typescript
import { createTmpDir, createEnvGuard, getFreePort } from "@molf-ai/test-utils";

// Create an isolated temporary directory (auto-cleaned)
const tmpDir = createTmpDir();
// tmpDir.path → "/tmp/molf-test-xxxxx"

// Temporarily set environment variables (restored after test)
const env = createEnvGuard();
env.set("GEMINI_API_KEY", "test-key");
// env.restore() in afterEach

// Get an OS-allocated free port
const port = await getFreePort();
```

## Integration Test Helpers (`packages/e2e/helpers/`)

These helpers spin up real server and worker instances for end-to-end testing.

### Starting a Test Server

`startTestServer()` is async and accepts optional configuration:

```typescript
import { startTestServer } from "../helpers/server";

const server = await startTestServer({
  mockResponses: [
    mockStreamText("Hello!"),
    mockToolCallResponse({ toolName: "grep", args: { pattern: "TODO" }, result: { matches: [] } }),
  ],
  approval: false,  // disable tool approval gate (internal test option, not a public config)
});
// server.url → "ws://127.0.0.1:{port}"
// server.token → auth token
// server.cleanup() → stop server
```

The `approval` option is an internal test-only parameter that disables the tool approval gate so existing tests run without requiring approval responses. It is not part of the public `ServerConfig` type. Pass `approval: true` to test approval flows.

`startTestServer()` internally calls `createTestProviderConfig(dataDir)` to set up a minimal provider registry with a single `gemini/test` model (128K context, 8K output). The `model` defaults to `"gemini/test"`.

### Connecting a Test Worker

```typescript
import { connectTestWorker } from "../helpers/worker";

const worker = await connectTestWorker(server, {
  name: "test-worker",
  tools: [{ name: "custom_tool", description: "...", inputSchema: {} }],
  skills: [{ name: "deploy", description: "Deploy the app", content: "..." }],
});
// worker.workerId → UUID
// worker.cleanup() → disconnect
```

### Prompt Helpers

```typescript
import { promptAndWait, promptAndCollect, collectEvents, waitUntil } from "../helpers/prompt";

// Send a prompt and wait for turn_complete
const result = await promptAndWait(client, sessionId, "Hello");

// Send a prompt and collect all events
const events = await promptAndCollect(client, sessionId, "List files");

// Collect events matching a filter
const toolEvents = await collectEvents(client, sessionId, (e) => e.type === "tool_call_start");

// Wait for a condition on events
await waitUntil(client, sessionId, (events) =>
  events.some((e) => e.type === "status_change" && e.status === "idle")
);
```

## Key Convention: Mock Before Import

Bun's module mocking requires mocks to be set up **before** the module under test is imported. This is the most common testing pitfall:

```typescript
import { mock, describe, test, expect } from "bun:test";

// 1. Set up mocks FIRST
mock.module("ai", () => ({
  streamText: mockStreamText("Mocked response"),
}));

// 2. THEN import the module under test (dynamic import)
const { Agent } = await import("../src/agent.js");

describe("Agent", () => {
  test("streams a response", async () => {
    const agent = new Agent(config, resolvedModel);
    // ... test logic
  });
});
```

If you import the module before setting up mocks, the real implementation will be used instead of the mock.

## Tool Approval Test Patterns

When testing with `approval: true`, tool calls that require user approval will block until a response is provided. Auto-approve pending requests by subscribing to the event bus:

```typescript
const server = await startTestServer({ approval: true, mockResponses: [...] });

// Auto-approve all tool calls via the event bus
server.eventBus.subscribe(sessionId, (ev) => {
  if (ev.type === "tool_approval_required") {
    queueMicrotask(() => server.approvalGate.reply(ev.approvalId, "once"));
  }
});
```

Use `"once"` to approve a single call, `"always"` to add a persistent allow rule, or `"reject"` to deny. The `queueMicrotask` wrapper ensures the reply runs after the approval promise is set up.

For dedicated approval flow tests, see `packages/e2e/tests/integration/tool-approval.test.ts` which covers approve-once, deny-with-feedback, always-approve with cascade, abort cancellation, and reconnect replay. See [Tool Approval](/server/tool-approval) for the full rule system and default rules.

## Integration Test Patterns

The integration tests in `packages/e2e/tests/integration/` demonstrate testing full server + worker + client flows. Notable patterns:

- **Event ordering**: `summarization.test.ts` verifies that `turn_complete` is emitted before `context_compacted`, testing the async post-turn summarization flow.
- **Persisted data verification**: Tests load sessions after prompts to verify fields like `usage` are correctly persisted on assistant messages.
- **Dual LLM mocking**: Summarization tests mock both `streamText` (for agent turns) and `generateText` (for summarization calls) using the AI mock harness.

### Provider Test Files

Unit tests covering the provider system in `packages/agent-core/tests/`:

| Test File | What It Tests |
|-----------|---------------|
| `catalog.test.ts` | models.dev catalog fetching, caching, refresh, disable via env var |
| `model-id.test.ts` | `parseModelId` / `formatModelId` parsing and edge cases |
| `provider-env.test.ts` | API key detection from environment variables |
| `provider-sdk.test.ts` | SDK instance creation and caching |
| `provider-transform.test.ts` | Provider-specific message transforms and options |
| `env.test.ts` | `Env` namespace snapshot behavior |

## Coverage

Run the coverage report:

```bash
bun run test:coverage
```

The report shows `% Funcs` and `% Lines` per file. All new code must have test coverage.

## See Also

- [Contributing](/reference/contributing) — design principles and step-by-step guides for adding tools, skills, and procedures
- [Architecture](/reference/architecture) — module structure and package dependencies
- [Sessions](/server/sessions) — context summarization behavior and trigger conditions
