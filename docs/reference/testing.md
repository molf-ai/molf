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

Mock the Vercel AI SDK's `streamText` to simulate LLM responses without hitting a real API:

```typescript
import { mockStreamText, mockToolCallResponse } from "@molf-ai/test-utils";

// Mock a simple text response
const mockStream = mockStreamText("Hello, I can help with that!");

// Mock a tool call followed by a text response
const mockTool = mockToolCallResponse({
  toolName: "shell_exec",
  args: { command: "ls" },
  result: { stdout: "file1.txt\nfile2.txt", stderr: "", exitCode: 0 },
  textAfter: "Here are the files in your directory.",
});
```

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

```typescript
import { startTestServer } from "../helpers/server";

const server = await startTestServer({
  mockResponses: [
    mockStreamText("Hello!"),
    mockToolCallResponse({ toolName: "grep", args: { pattern: "TODO" }, result: { matches: [] } }),
  ],
});
// server.url → "ws://127.0.0.1:{port}"
// server.token → auth token
// server.cleanup() → stop server
```

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
    const agent = new Agent();
    // ... test logic
  });
});
```

If you import the module before setting up mocks, the real implementation will be used instead of the mock.

## Coverage

Run the coverage report:

```bash
bun run test:coverage
```

The report shows `% Funcs` and `% Lines` per file. All new code must have test coverage.

## See Also

- [Contributing](/reference/contributing) — design principles and step-by-step guides for adding tools, skills, and procedures
- [Architecture](/reference/architecture) — module structure and package dependencies
