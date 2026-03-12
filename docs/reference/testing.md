# Testing

Molf Assistant uses Vitest as its test runner. All new code must have test coverage.

## Running Tests

```bash
# All tests (unit + integration)
pnpm test

# Unit tests only
pnpm test:unit

# Integration tests (e2e)
pnpm test:e2e

# Coverage report
pnpm test:coverage

# Single file
pnpm vitest run packages/server/tests/session-mgr.test.ts

# Type-check (no emit)
pnpm exec tsc --noEmit -p packages/server/tsconfig.json
```

## Test Tiers

| Tier | Location | Command | Description |
|------|----------|---------|-------------|
| Unit | `packages/{pkg}/tests/` | `pnpm test:unit` | Fast, isolated tests per package |
| Integration | `packages/e2e/tests/integration/` | `pnpm test:e2e` | Full server + worker tests |
| Live | `packages/e2e/tests/live/` | `pnpm test:live` | Real LLM calls (requires `GEMINI_API_KEY` + `MOLF_LIVE_TEST=1`) |

Unit tests live alongside each package. Integration and live tests are centralized in the `e2e` package.

## Mock Patterns

### vi.mock Hoisting

`vi.mock` is hoisted automatically by Vitest, so static imports work correctly even when placed after the mock declaration:

```typescript
import { vi, describe, it, expect } from "vitest";

vi.mock("ai", () => ({
  streamText: mockStreamText(/* ... */),
}));

// This import sees the mocked version of "ai"
import { Agent } from "../src/agent.js";
```

This is the standard pattern used throughout the codebase. The mock must be defined before the import of the module under test that depends on the mocked module.

### Mocking streamText

The `test-utils` package provides `mockStreamText` to simulate Vercel AI SDK responses:

```typescript
import { mockStreamText, mockToolCallResponse } from "@molf-ai/test-utils";

vi.mock("ai", () => ({
  streamText: mockStreamText(
    // First call: LLM returns a tool call
    mockToolCallResponse("read_file", { path: "test.txt" }),
    // Second call: LLM returns text
    { text: "Here is the file content." },
  ),
}));
```

`mockStreamText` accepts a sequence of responses. Each call to `streamText` consumes the next response in order. `mockToolCallResponse` creates a response that simulates the LLM requesting a tool call.

## Test Utilities (`packages/test-utils/`)

The `test-utils` package provides shared helpers used by unit and integration tests.

### createTmpDir

Creates a temporary directory for test isolation. Returns the path and a cleanup function.

```typescript
import { createTmpDir } from "@molf-ai/test-utils";

const { path, cleanup } = createTmpDir();
// Use `path` as a working directory for the test
// Call `cleanup()` in afterEach/afterAll
```

### createEnvGuard

Snapshots environment variables and restores them after the test, preventing env var pollution across tests.

```typescript
import { createEnvGuard } from "@molf-ai/test-utils";

const env = createEnvGuard();
// Modify process.env freely
env.restore(); // Restores original values
```

### getFreePort

Finds an available TCP port for test servers.

```typescript
import { getFreePort } from "@molf-ai/test-utils";

const port = await getFreePort();
```

### mockStreamText / mockToolCallResponse

Mock factories for Vercel AI SDK's `streamText` function. See the [Mocking streamText](#mocking-streamtext) section above.

## Integration Helpers (`packages/e2e/helpers/`)

The `e2e` package provides helpers for spinning up real server and worker instances in tests.

### startTestServer

Starts a test server instance with TLS disabled and returns a client and cleanup function.

```typescript
import { startTestServer } from "../helpers/server.js";

const { client, token, port, cleanup } = await startTestServer();
// `client` is a tRPC client connected to the test server
// Call `cleanup()` in afterAll
```

### connectTestWorker

Connects a test worker to a running test server.

```typescript
import { connectTestWorker } from "../helpers/worker.js";

const { workerId, cleanup } = await connectTestWorker({
  serverUrl: `ws://127.0.0.1:${port}`,
  token,
  name: "test-worker",
});
```

### promptAndWait

Sends a prompt and waits for the `turn_complete` event. Useful for testing end-to-end flows.

```typescript
import { promptAndWait } from "../helpers/prompt.js";

const result = await promptAndWait(client, {
  sessionId,
  text: "Hello",
});
// result.message contains the assistant response
```

### waitForEvent

Waits for a specific event type on an event subscription.

```typescript
import { waitForEvent } from "../helpers/events.js";

const event = await waitForEvent(subscription, "tool_call_start");
```

## Writing Tests

### Conventions

- Place unit tests at `packages/{pkg}/tests/{module}.test.ts`.
- Use `vi.mock` for mocking external dependencies, not test-only code paths in production modules.
- Use `vi.spyOn` for observing calls to real implementations.
- Clean up temporary files and restore environment variables in `afterEach` or `afterAll`.
- Integration tests should use the e2e helpers rather than manually starting servers.

### Example Unit Test

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTmpDir, createEnvGuard } from "@molf-ai/test-utils";

const env = createEnvGuard();
const tmp = createTmpDir();

afterEach(() => {
  env.restore();
  tmp.cleanup();
});

describe("MyModule", () => {
  it("does something", async () => {
    // Arrange
    process.env.SOME_VAR = "test";

    // Act
    const result = await myFunction(tmp.path);

    // Assert
    expect(result).toBe("expected");
  });
});
```

## See also

- [Contributing](./contributing.md) -- design principles and development setup
- [Logging](./logging.md) -- enabling debug logs during test development
