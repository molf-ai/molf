# Molf Test Plan

## Overview

This document describes the complete test strategy for the Molf monorepo. The goal is to provide confidence that **every component works correctly in isolation and in combination**, covering unit tests, integration tests, and multi-service end-to-end scenarios.

**Framework**: `bun:test` (`describe`, `test`, `expect`, `beforeAll`, `afterAll`, `beforeEach`, `mock`)
**Test tiers**: Unit (fast, no I/O) → Integration (real servers, in-process) → Live (real Gemini API, opt-in)
**LLM strategy**: All Gemini/streamText calls are mocked in unit/integration — live tests hit real API behind env flag
**Filesystem strategy**: Real temp directories via `mkdtemp`, cleaned up in `afterAll`
**Integration strategy**: Real in-process WebSocket servers on random ports
**Coverage enforcement**: Minimum thresholds enforced — build fails if coverage drops below targets

---

## Directory Structure

```
packages/
  test-utils/              # @molf-ai/test-utils — pure helpers, zero @molf-ai/* deps
    src/
      tmpdir.ts            # Temp directory creation + cleanup
      env-guard.ts         # Environment variable save/restore
      port.ts              # Free port allocation
      mock-stream.ts       # LLM stream mocking (shared across packages)
      index.ts             # Re-exports all helpers
    package.json           # { "name": "@molf-ai/test-utils", ... }
  agent-core/tests/
    config.test.ts
    session.test.ts
    tool-registry.test.ts
    agent.test.ts
    agent-events.test.ts
    agent-abort.test.ts
    agent-tool-loop.test.ts
    system-prompts.test.ts
    tools/
      shell-exec.test.ts
      read-file.test.ts
      write-file.test.ts
  protocol/tests/
    schemas.test.ts
    types.test.ts
    cli.test.ts
  server/tests/
    auth.test.ts
    config.test.ts
    session-mgr.test.ts
    event-bus.test.ts
    tool-dispatch.test.ts
    connection-registry.test.ts
    agent-runner.test.ts
    router.test.ts
    server.test.ts
  worker/tests/
    identity.test.ts
    skills.test.ts
    tool-executor.test.ts
    cli.test.ts
  tui/tests/
    use-server.test.ts
    commands.test.ts
  e2e/                       # @molf-ai/e2e — integration + live tests
    package.json             # { "name": "@molf-ai/e2e", "private": true }
    helpers/
      test-server.ts         # startTestServer() — depends on @molf-ai/server
      test-worker.ts         # connectTestWorker() — depends on @molf-ai/worker
      wait-for-event.ts      # Event subscription polling helper
      index.ts               # Re-exports all helpers
    tests/
      integration/
        worker-connection.test.ts
        server-worker.test.ts
        server-multi-worker.test.ts
        full-flow.test.ts
        reconnection.test.ts
        concurrent-sessions.test.ts
        tool-approval.test.ts
      live/
        gemini-smoke.live.test.ts
        agent-live.live.test.ts
```

---

## Mocking Strategy

### LLM Mocking (`streamText`)

Every test that involves the Agent class must mock `streamText` from the `"ai"` package. The mock should return an async iterable `fullStream` that yields controlled events.

The shared mock helper lives in `packages/test-utils/src/mock-stream.ts` (part of `@molf-ai/test-utils`):
- `mockStreamText(events)` — accepts an array of stream events (`text-delta`, `tool-call`, `tool-result`, `finish`, `error`) and returns a mock `streamText` result with `fullStream` as an `AsyncIterable`
- `mockTextResponse(text)` — shorthand that yields `[text-delta, finish("stop")]`
- `mockToolCallResponse(toolName, args, result)` — yields `[tool-call, tool-result, finish("tool-calls")]` then on second call yields `[text-delta("Done"), finish("stop")]`

Use `mock.module("ai", ...)` from `bun:test` to replace the `streamText` export. Also mock `@ai-sdk/google` so `createGoogleGenerativeAI` returns a dummy model.

### WebSocket / tRPC Mocking (for unit tests)

For **unit tests** of individual server components (EventBus, ToolDispatch, etc.), no mocking is needed — these are pure classes.

For **router unit tests**, use tRPC's `createCallerFactory` to call procedures directly without WebSocket transport.

For **integration tests**, spin up real servers via `startServer()` on port 0 (random) and connect real tRPC WebSocket clients.

### Filesystem

Use `fs.mkdtempSync(path.join(os.tmpdir(), "molf-test-"))` to create isolated temp directories. Store the path in a `let tmpDir: string` variable, clean up in `afterAll` with `fs.rmSync(tmpDir, { recursive: true, force: true })`.

### AgentEvent Type Mapping (agent-core → protocol)

`@molf-ai/agent-core` and `@molf-ai/protocol` define **different** `AgentEvent` types. The `AgentRunner.mapAgentEvent()` method in `@molf-ai/server` bridges the two. Tests must account for this:

| agent-core (`AgentCoreEvent`) | protocol (`AgentEvent`) | Mapping notes |
|-------------------------------|-------------------------|---------------|
| `status_change { status }` | `status_change { status }` | Direct pass-through |
| `content_delta { delta, content }` | `content_delta { delta, content }` | Direct pass-through |
| `tool_call_start { toolCallId, toolName, arguments }` | `tool_call_start { toolCallId, toolName, arguments }` | Direct pass-through |
| `tool_call_end { toolCallId, toolName, result }` | `tool_call_end { toolCallId, toolName, result }` | Direct pass-through |
| `turn_complete { message: SessionMessage }` | `turn_complete { message: { id, role, content, timestamp } }` | Strips extra fields |
| `error { error: Error }` | `error { code: "AGENT_ERROR", message: string }` | **Converted**: Error object → structured `{ code, message }` |
| *(not present)* | `tool_approval_required { toolCallId, toolName, arguments, sessionId }` | **Server-only**: Emitted by server router, not by agent-core |

**Testing implications:**
- **agent-core unit tests** assert raw `AgentCoreEvent` types (e.g., `error.error instanceof Error`)
- **server/agent-runner tests** assert the mapping produces correct protocol `AgentEvent` types (e.g., `error.code === "AGENT_ERROR"`)
- **`tool_approval_required`** is tested only in server router tests and protocol schema tests — it has no agent-core counterpart

---

## Test Helpers

Helpers are split into two locations based on their dependency footprint:

- **`@molf-ai/test-utils`** (`packages/test-utils/`) — Pure functions with zero `@molf-ai/*` dependencies. Safe to import from any package. Contains: `tmpdir`, `env-guard`, `port`, `mock-stream`.
- **`packages/e2e/helpers/`** — Infrastructure helpers that depend on `@molf-ai/server`, `@molf-ai/worker`, etc. Only imported by e2e tests. Contains: `test-server`, `test-worker`, `wait-for-event`.

### `@molf-ai/test-utils` package

Added as a `devDependency` in each package that needs temp dirs, env vars, or mock streams.

```json
// packages/test-utils/package.json
{
  "name": "@molf-ai/test-utils",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  }
}

// In each consuming package's package.json:
{
  "devDependencies": {
    "@molf-ai/test-utils": "workspace:*"
  }
}
```

### `tmpdir.ts` — Temp directory lifecycle

Creates an isolated temp directory and guarantees cleanup, even if a test throws.

```ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface TmpDir {
  path: string;
  /** Create a file inside the temp dir. Returns absolute path. */
  writeFile(relativePath: string, content: string): string;
  /** Recursively remove the temp dir. Safe to call multiple times. */
  cleanup(): void;
}

export function createTmpDir(prefix = "molf-test-"): TmpDir {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let cleaned = false;

  return {
    path: dirPath,
    writeFile(relativePath: string, content: string): string {
      const fullPath = path.join(dirPath, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
      return fullPath;
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(dirPath, { recursive: true, force: true });
    },
  };
}
```

**Usage pattern:**

```ts
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });
```

### `env-guard.ts` — Environment variable save/restore

Prevents env var mutations in one test from leaking into others. Captures a snapshot before the test block, restores it after.

```ts
export interface EnvGuard {
  /** Set an env var for the duration of the test. */
  set(key: string, value: string): void;
  /** Delete an env var for the duration of the test. */
  delete(key: string): void;
  /** Restore all env vars to their original state. Call in afterAll/afterEach. */
  restore(): void;
}

export function createEnvGuard(): EnvGuard {
  const originals = new Map<string, string | undefined>();

  return {
    set(key: string, value: string) {
      if (!originals.has(key)) {
        originals.set(key, process.env[key]);
      }
      process.env[key] = value;
    },
    delete(key: string) {
      if (!originals.has(key)) {
        originals.set(key, process.env[key]);
      }
      delete process.env[key];
    },
    restore() {
      for (const [key, value] of originals) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      originals.clear();
    },
  };
}
```

**Usage pattern:**

```ts
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";

let env: EnvGuard;
beforeEach(() => { env = createEnvGuard(); });
afterEach(() => { env.restore(); });

test("uses MOLF_TOKEN env var", () => {
  env.set("MOLF_TOKEN", "test-token-123");
  // ... test code that reads process.env.MOLF_TOKEN
});
```

### `port.ts` — Free port allocation

Binds to port 0, reads the OS-assigned port, then closes the socket. Avoids hardcoded ports that conflict across parallel test files.

```ts
import net from "node:net";

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Failed to get port")));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
```

**Note:** For most tests, passing `port: 0` to `startServer()` is sufficient. This helper is for cases where you need to know the port before starting the server (e.g., constructing URLs for config files).

### E2E Helpers (`packages/e2e/helpers/`)

These helpers depend on `@molf-ai/server`, `@molf-ai/worker`, and `@molf-ai/protocol`. They live inside the e2e package since only e2e tests use them.

```ts
// packages/e2e/helpers/index.ts — re-exports all e2e helpers
export { startTestServer, type TestServer } from "./test-server.js";
export { connectTestWorker, type TestWorker } from "./test-worker.js";
export { waitForEvent } from "./wait-for-event.js";
```

#### `test-server.ts` — Server lifecycle for integration tests

Wraps `startServer()` with temp dir creation, auth token extraction, and cleanup.

```ts
import { startServer } from "@molf-ai/server";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

export interface TestServer {
  url: string;
  token: string;
  port: number;
  tmp: TmpDir;
  cleanup(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const tmp = createTmpDir("molf-server-test-");
  const server = await startServer({ host: "127.0.0.1", port: 0, dataDir: tmp.path });
  const addr = server.wss.address() as { port: number };

  return {
    url: `ws://127.0.0.1:${addr.port}`,
    token: server.token,
    port: addr.port,
    tmp,
    async cleanup() {
      server.close();
      tmp.cleanup();
    },
  };
}
```

#### `test-worker.ts` — Worker connection for integration tests

Wraps `connectToServer()` with a pre-generated workerId (since `connectToServer()` returns only `{ close() }`).

```ts
import { connectToServer, ToolExecutor } from "@molf-ai/worker";
import { getOrCreateWorkerId } from "@molf-ai/worker";
import type { WorkerSkillInfo } from "@molf-ai/protocol";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

export interface TestWorker {
  workerId: string;
  tmp: TmpDir;
  cleanup(): Promise<void>;
}

export async function connectTestWorker(
  url: string,
  token: string,
  name: string,
  tools?: Record<string, { description: string; execute: Function }>,
  skills?: WorkerSkillInfo[],
): Promise<TestWorker> {
  const tmp = createTmpDir("molf-worker-test-");
  const workerId = getOrCreateWorkerId(tmp.path);

  const executor = new ToolExecutor();
  if (tools) {
    for (const [toolName, def] of Object.entries(tools)) {
      executor.registerTool(toolName, def);
    }
  }

  const conn = await connectToServer({
    serverUrl: url,
    token,
    workerId,
    name,
    toolExecutor: executor,
    skills: skills ?? [],
  });

  return {
    workerId,
    tmp,
    async cleanup() {
      conn.close();
      tmp.cleanup();
    },
  };
}
```

#### `wait-for-event.ts` — Event subscription polling

Subscribes to `agent.onEvents` and resolves when a matching event arrives, or rejects on timeout.

```ts
export function waitForEvent<T extends { type: string }>(
  subscribe: (sessionId: string, handler: (event: T) => void) => () => void,
  sessionId: string,
  eventType: string,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for "${eventType}" event after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = subscribe(sessionId, (event) => {
      if (event.type === eventType) {
        clearTimeout(timer);
        unsub();
        resolve(event);
      }
    });
  });
}
```

---

## Package: `@molf-ai/agent-core`

### `config.test.ts` — AgentConfig creation

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `createConfig()` with no args returns defaults | model=`gemini-2.5-flash`, maxSteps=10, no systemPrompt |
| 2 | `createConfig()` with partial llm overrides | Overridden fields merged, others keep defaults |
| 3 | `createConfig()` with partial behavior overrides | systemPrompt set, maxSteps overridden |
| 4 | `createConfig()` with full overrides | All fields match provided values |
| 5 | Overrides don't mutate default config object | Call twice with different overrides, verify no leakage |

### `session.test.ts` — Session message management

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `addMessage()` assigns id and timestamp | Returned message has `msg_` prefix id, numeric timestamp |
| 2 | `addMessage()` for user role | Stored in messages array with correct role |
| 3 | `addMessage()` for assistant with toolCalls | toolCalls array preserved |
| 4 | `addMessage()` for tool role | toolCallId and toolName preserved |
| 5 | `getMessages()` returns readonly array | Verify message count increases with adds |
| 6 | `getLastMessage()` returns most recent | Returns last added message |
| 7 | `getLastMessage()` on empty session | Returns undefined |
| 8 | `clear()` removes all messages | length becomes 0 |
| 9 | `length` getter | Matches actual count |
| 10 | `serialize()` produces a deep copy | Modifying original doesn't affect serialized |
| 11 | `Session.deserialize()` restores messages | All fields match, correct count |
| 12 | Round-trip serialize/deserialize | Serialize, deserialize, verify deep equality |
| 13 | `toModelMessages()` — user message | Produces `{ role: "user", content: string }` |
| 14 | `toModelMessages()` — plain assistant | Produces `{ role: "assistant", content: string }` |
| 15 | `toModelMessages()` — assistant with tool calls | Produces content array with text + tool-call parts |
| 16 | `toModelMessages()` — tool result (JSON) | Parses JSON content into `{ type: "json", value }` |
| 17 | `toModelMessages()` — tool result (plain text) | Falls back to `{ type: "text", value }` |
| 18 | `generateMessageId()` format | Starts with `msg_`, 16+ chars |
| 19 | `toModelMessages()` — empty session | Returns empty array |
| 20 | `toModelMessages()` — assistant with empty toolCalls array | Treated as plain assistant (no tool-call parts) |
| 21 | `toModelMessages()` — assistant with content and toolCalls | Text part first, then tool-call parts |
| 22 | `toModelMessages()` — tool message without toolName | Falls back to `"unknown"` toolName |
| 23 | `deserialize()` with empty messages array | Creates empty session, length === 0 |

### `tool-registry.test.ts` — ToolRegistry

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `register()` adds tool | `has()` returns true, `size` increases |
| 2 | `register()` duplicate name throws | Error message includes tool name |
| 3 | `unregister()` existing tool | Returns true, `has()` becomes false |
| 4 | `unregister()` nonexistent tool | Returns false |
| 5 | `get()` returns tool def | Returns the registered object |
| 6 | `get()` missing tool | Returns undefined |
| 7 | `getAll()` returns shallow copy | Modifying copy doesn't affect registry |
| 8 | `clear()` removes all | size becomes 0 |
| 9 | `size` getter accuracy | Reflects actual count after multiple ops |

### `agent.test.ts` — Agent core prompt flow (mocked LLM)

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Simple text response | `prompt()` returns assistant message with correct content |
| 2 | Status transitions: idle → streaming → idle | Event handler receives `status_change` events in order |
| 3 | `content_delta` events emitted during streaming | Handler accumulates deltas matching final content |
| 4 | `turn_complete` event emitted | Contains final assistant message |
| 5 | User message persisted to session | session.getMessages() includes the user message |
| 6 | Assistant message persisted to session | session.getMessages() includes assistant reply |
| 7 | Calling `prompt()` while busy throws | "Agent is busy" error |
| 8 | Constructor with existing session | Messages from existing session used in context |
| 9 | `resetSession()` clears history | session.length becomes 0, status resets to idle |
| 10 | `getLastPromptMessages()` returns messages from last turn | Correct array of messages from single prompt |
| 11 | Missing API key throws | "GEMINI_API_KEY is required" error when no env var or config |
| 12 | Config apiKey override used | Mock verifies createGoogleGenerativeAI called with correct key |

### `agent-events.test.ts` — Event subscription

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `onEvent()` receives all event types | Mock handler called for each event type |
| 2 | Multiple handlers receive same events | Both handlers invoked |
| 3 | Unsubscribe removes handler | After unsubscribe, handler not called |
| 4 | `error` event emitted on LLM error | Event type is "error", error message matches |

### `agent-abort.test.ts` — Abort behavior

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `abort()` during streaming sets status to aborted | Status is "aborted" |
| 2 | `abort()` causes prompt to throw AbortError | Caught error has name "AbortError" |
| 3 | `abort()` when idle does nothing | No status change event |
| 4 | After abort, new prompt can be started | Second prompt succeeds |

### `agent-tool-loop.test.ts` — Multi-step tool calling

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Single tool call cycle | tool_call_start → tool_call_end → final text |
| 2 | Multiple sequential tool calls (2 steps) | Two tool calls before final response |
| 3 | `maxSteps` limit reached | Agent stops looping, returns "(Reached maximum steps)" |
| 4 | Status: idle → streaming → executing_tool → streaming → idle | Full status lifecycle |
| 5 | Tool results persisted in session | Tool messages in session history |
| 6 | Tool error emitted as error event | `tool-error` stream part triggers error event |

### `system-prompts.test.ts`

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `getDefaultSystemPrompt()` returns non-empty string | Contains expected keywords |
| 2 | `buildSystemPrompt()` with all args | Combines base, instructions, and skill hint |
| 3 | `buildSystemPrompt()` with no optional args | Returns base only |

### `tools/shell-exec.test.ts` — Built-in shell tool

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Execute `echo hello` | Returns stdout containing "hello" |
| 2 | Execute failing command | Returns error / stderr |
| 3 | Timeout respected | Long command killed after timeout |

### `tools/read-file.test.ts` — Built-in read-file tool

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Read existing file | Returns file content |
| 2 | Read nonexistent file | Returns error message |

### `tools/write-file.test.ts` — Built-in write-file tool

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Write new file | File created with correct content |
| 2 | Overwrite existing file | Content replaced |

---

## Package: `@molf-ai/protocol`

### `schemas.test.ts` — Zod schema validation

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `sessionCreateInput` — valid input passes | No validation error |
| 2 | `sessionCreateInput` — missing workerId fails | Zod error on required field |
| 3 | `sessionCreateInput` — invalid UUID fails | Zod error on UUID format |
| 4 | `agentPromptInput` — valid input | Passes validation |
| 5 | `agentPromptInput` — empty text passes | String type accepts empty |
| 6 | `workerRegisterInput` — valid with tools array | Passes with correct structure |
| 7 | `workerRegisterInput` — missing name fails | Zod error |
| 8 | `workerToolResultInput` — valid with error field | Optional error passes |
| 9 | `agentEventSchema` — each discriminated variant | All 7 event types validate correctly |
| 10 | `agentEventSchema` — unknown type fails | Discriminated union rejects |
| 11 | `sessionMessageSchema` — valid user message | Passes |
| 12 | `sessionMessageSchema` — valid tool message with toolCallId | Passes |
| 13 | `sessionRenameInput` — valid | Passes |
| 14 | `toolApproveInput` — valid | Passes |
| 15 | `workerOnToolCallInput` — invalid UUID fails | Zod error |

### `cli.test.ts` — CLI argument parser

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Parse valid flags | Returns correct values |
| 2 | Short flag aliases | `-c` maps to `config` |
| 3 | Missing required flag with env fallback | Reads from env |
| 4 | `--help` flag | Returns help text or exits |
| 5 | Invalid flag | Error or ignored |

---

## Package: `@molf-ai/server`

### `auth.test.ts` — Token auth (basic correctness)

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `initAuth()` generates token and saves hash | server.json created, token is hex string |
| 2 | `verifyToken()` with correct token | Returns true |
| 3 | `verifyToken()` with wrong token | Returns false |
| 4 | `initAuth()` with `MOLF_TOKEN` env var | Uses env token, hash matches |
| 5 | `verifyToken()` when server.json missing | Returns false |
| 6 | `verifyToken()` when server.json is corrupt | Returns false |
| 7 | `initAuth()` called twice regenerates token | Second call creates new token |

### `config.test.ts` — Server configuration

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `loadConfig()` with no file returns defaults | host=127.0.0.1, port=7600 |
| 2 | `loadConfig()` with YAML file | Parsed values override defaults |
| 3 | `loadConfig()` with partial YAML | Missing fields fall back to defaults |
| 4 | `loadConfig()` resolves relative dataDir from config location | Path resolved correctly |
| 5 | `parseServerArgs()` with `--config` | Returns resolved path |
| 6 | `parseServerArgs()` with `--port` | Port parsed as number |
| 7 | `parseServerArgs()` with short flags (`-p`, `-H`) | Correct mapping |

### `session-mgr.test.ts` — Session persistence

Uses real temp directory for all tests.

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `create()` returns SessionFile with UUID | sessionId is UUID, messages empty |
| 2 | `create()` persists to disk | JSON file exists in sessions dir |
| 3 | `list()` returns created sessions | Correct count, sorted by lastActiveAt desc |
| 4 | `list()` on empty dir | Returns empty array |
| 5 | `load()` from memory cache | Same object reference |
| 6 | `load()` from disk (new SessionManager instance) | Correct session restored |
| 7 | `load()` nonexistent session | Returns null |
| 8 | `delete()` removes from memory and disk | load returns null, file gone |
| 9 | `delete()` nonexistent session | Returns false |
| 10 | `rename()` updates name in memory and disk | Reloaded session has new name |
| 11 | `rename()` nonexistent session | Returns false |
| 12 | `addMessage()` appends to session | Message count increases |
| 13 | `addMessage()` on unloaded session throws | Error thrown |
| 14 | `save()` updates lastActiveAt and persists | File on disk reflects new timestamp |
| 15 | `getMessages()` returns messages | Correct array |
| 16 | Corrupt JSON file skipped in `list()` | Other sessions still returned |

### `event-bus.test.ts` — Per-session pub/sub

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `subscribe()` + `emit()` delivers event | Listener called with correct event |
| 2 | Multiple listeners on same session | All receive the event |
| 3 | Listeners on different sessions isolated | Session B listener not called for session A emit |
| 4 | Unsubscribe removes listener | No longer called after unsubscribe |
| 5 | `hasListeners()` true when subscribed | Returns true |
| 6 | `hasListeners()` false after all unsubscribed | Returns false |
| 7 | `hasListeners()` false for unknown session | Returns false |
| 8 | Emit to session with no listeners | No error thrown |

### `tool-dispatch.test.ts` — Tool call routing

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `dispatch()` + `resolveToolCall()` flow | dispatch promise resolves with result |
| 2 | `subscribeWorker()` yields queued requests | Requests dispatched before subscribe are drained |
| 3 | `subscribeWorker()` yields live requests | Request dispatched after subscribe arrives |
| 4 | `resolveToolCall()` unknown toolCallId | Returns false |
| 5 | `workerDisconnected()` resolves pending with error | dispatch promise gets error result |
| 6 | `workerDisconnected()` cleans up queues | No lingering state |
| 7 | Multiple concurrent dispatches to same worker | All resolved independently |
| 8 | Dispatch to worker not yet subscribed (queuing) | Request queued, then delivered on subscribe |
| 9 | Abort signal stops `subscribeWorker()` | Generator completes |
| 10 | `resolveToolCall()` with error string | Error field passed through |

### `connection-registry.test.ts` — Connection tracking

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `registerWorker()` | getWorker returns registration |
| 2 | `registerWorker()` duplicate ID throws | Error message |
| 3 | `registerClient()` | getClients includes entry |
| 4 | `unregister()` | isConnected returns false |
| 5 | `getWorkers()` filters by role | Only workers returned |
| 6 | `getClients()` filters by role | Only clients returned |
| 7 | `counts()` accuracy | Correct worker and client counts |
| 8 | `get()` returns registration by ID | Correct entry |
| 9 | `get()` unknown ID | Returns undefined |

### `agent-runner.test.ts` — Agent orchestration (mocked LLM)

Requires mocking `streamText`. Uses real SessionManager (temp dir), EventBus, ConnectionRegistry, ToolDispatch.

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `prompt()` with valid session and connected worker | Returns messageId, emits events via EventBus |
| 2 | `prompt()` with nonexistent session | Throws SessionNotFoundError |
| 3 | `prompt()` while agent is busy | Throws AgentBusyError |
| 4 | `prompt()` with disconnected worker | Throws WorkerDisconnectedError |
| 5 | `getStatus()` returns idle for unknown session | "idle" |
| 6 | `abort()` during prompt | Returns true, agent stops |
| 7 | `abort()` on inactive session | Returns false |
| 8 | Events forwarded to EventBus | Subscribe to EventBus, verify mapped events received |
| 9 | Messages persisted to SessionManager after prompt | Session file contains user + assistant messages |
| 10 | Remote tool execution via ToolDispatch | Tool call dispatched to worker, result returned to agent |
| 11 | `buildAgentSystemPrompt()` with skills | Contains skill hint |
| 12 | `buildAgentSystemPrompt()` without skills | No skill hint |
| 13 | `buildSkillTool()` with skills | Returns tool def, execute resolves skill content |
| 14 | `buildSkillTool()` without skills | Returns null |
| 15 | `buildSkillTool()` execute with unknown skill | Returns error object |
| 16 | `buildRemoteTools()` creates tool for each worker tool | ToolSet has correct keys |
| 17 | `buildRemoteTools()` tool execute dispatches via ToolDispatch | dispatch called with correct workerId and args |
| 18 | `buildRemoteTools()` tool execute throws on dispatch error | Error propagated from ToolDispatch error field |
| 19 | `mapAgentEvent()` converts `error` to `{ code, message }` | `error.error` (Error object) → `{ code: "AGENT_ERROR", message }` |
| 20 | `mapAgentEvent()` converts `turn_complete` stripping extra fields | Only `id, role, content, timestamp` in output message |
| 21 | `mapAgentEvent()` returns null for unknown event type | Null returned, no crash |

### `router.test.ts` — tRPC router procedures

Use `createCallerFactory` to call procedures directly, providing a mock ServerContext.

**Auth middleware (`authedProcedure`):**

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Authed procedure with valid token | Procedure executes, no error |
| 2 | Authed procedure with null token | TRPCError UNAUTHORIZED, "Missing authentication token" |

**Session procedures:**

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `session.create` with valid worker | Returns sessionId, name, workerId |
| 2 | `session.create` with nonexistent worker | TRPCError NOT_FOUND |
| 3 | `session.list` | Returns sessions array |
| 4 | `session.load` with valid sessionId | Returns messages |
| 5 | `session.load` nonexistent | TRPCError NOT_FOUND |
| 6 | `session.delete` existing | deleted=true |
| 7 | `session.delete` nonexistent | deleted=false |
| 8 | `session.rename` existing | renamed=true |
| 9 | `session.rename` nonexistent | TRPCError NOT_FOUND |

**Agent procedures:**

| # | Test case | What to verify |
|---|-----------|----------------|
| 10 | `agent.list` with connected workers | Returns worker info |
| 11 | `agent.prompt` valid | Returns messageId |
| 12 | `agent.prompt` session not found | TRPCError NOT_FOUND |
| 13 | `agent.prompt` agent busy | TRPCError CONFLICT |
| 14 | `agent.prompt` worker disconnected | TRPCError PRECONDITION_FAILED |
| 15 | `agent.abort` | Returns aborted boolean |
| 16 | `agent.status` | Returns current status |
| 17 | `agent.onEvents` subscription | Yields events emitted to EventBus |

**Tool procedures:**

| # | Test case | What to verify |
|---|-----------|----------------|
| 18 | `tool.list` with valid session and connected worker | Returns tool list |
| 19 | `tool.list` with disconnected worker | Returns empty array |
| 20 | `tool.list` nonexistent session | TRPCError NOT_FOUND |
| 21 | `tool.approve` | Returns applied=true (stub) |
| 22 | `tool.deny` | Returns applied=false (stub) |

**Worker procedures:**

| # | Test case | What to verify |
|---|-----------|----------------|
| 23 | `worker.register` | Worker appears in connectionRegistry |
| 24 | `worker.register` duplicate | TRPCError CONFLICT |
| 25 | `worker.rename` | Name updated |
| 26 | `worker.rename` nonexistent | TRPCError NOT_FOUND |
| 27 | `worker.onToolCall` subscription | Yields dispatched tool calls |
| 28 | `worker.toolResult` | Resolves pending dispatch |

### `server.test.ts` — Server startup/shutdown

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `startServer()` creates WSS on given port | wss.address().port matches |
| 2 | `close()` shuts down cleanly | No error, port released |
| 3 | Auth token generated and accessible | server.token is a hex string |
| 4 | `_ctx` exposes internal services | All 5 services accessible |
| 5 | WebSocket connection with valid token accepted | Client connects without error |
| 6 | WebSocket connection with invalid token | Auth fails, procedures reject |

---

## Package: `@molf-ai/worker`

### `identity.test.ts` — Persistent worker ID

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | First call creates UUID | Returns valid UUID, file created |
| 2 | Second call returns same UUID | Same value, no file rewrite |
| 3 | Corrupt file regenerates UUID | New UUID, file overwritten |
| 4 | Creates `.molf/` directory if missing | Directory created |

### `skills.test.ts` — Skill loading

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `loadSkills()` with valid skill directory | Returns WorkerSkillInfo with name, description, content |
| 2 | `loadSkills()` with YAML frontmatter | name/description parsed from frontmatter |
| 3 | `loadSkills()` without frontmatter | Falls back to directory name, empty description |
| 4 | `loadSkills()` with multiple skills | Returns array with all skills |
| 5 | `loadSkills()` with no skills directory | Returns empty array |
| 6 | `loadSkills()` skips files (not directories) | Only directories processed |
| 7 | `loadSkills()` skips dirs without SKILL.md | Not included in results |
| 8 | `loadAgentsDoc()` finds AGENTS.md | Returns content and source="AGENTS.md" |
| 9 | `loadAgentsDoc()` falls back to CLAUDE.md | Returns content and source="CLAUDE.md" |
| 10 | `loadAgentsDoc()` no instruction file | Returns null |

### `tool-executor.test.ts` — Tool execution

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `registerTool()` and `execute()` | Returns result from execute function |
| 2 | `registerTools()` batch | All tools registered |
| 3 | `registerToolSet()` from Vercel AI SDK format | Tools extracted correctly |
| 4 | `execute()` unknown tool | Returns `{ result: null, error: "not found" }` |
| 5 | `execute()` tool without execute function | Returns `{ result: null, error: "no execute" }` |
| 6 | `execute()` tool that throws | Returns `{ result: null, error: "message" }` |
| 7 | `getToolInfos()` returns JSON Schema | Zod schema converted to JSON Schema |
| 8 | `getToolInfos()` with plain JSON Schema input | Passed through unchanged |

### `cli.test.ts` — Worker CLI argument parsing

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `--name` flag parsed | Returns correct name |
| 2 | `--name` missing | Error or default behavior |
| 3 | `--workdir` flag | Returns resolved path |
| 4 | `--workdir` defaults to cwd | Falls back to `process.cwd()` |
| 5 | `--server-url` flag | Returns URL string |
| 6 | `--server-url` defaults to env var | Reads `MOLF_SERVER_URL` |
| 7 | `--token` flag | Returns token string |
| 8 | `--token` falls back to `MOLF_TOKEN` env | Reads from env |

---

## Package: `@molf-ai/tui`

### `use-server.test.ts` — Server hook logic

Mock the tRPC client layer (no real server). Test the hook's state management logic.

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Initial state | connected=false, messages=[], status="idle" |
| 2 | `sendMessage()` calls agent.prompt | tRPC mock called with correct args |
| 3 | Event subscription processes status_change | Status state updated |
| 4 | Event subscription processes content_delta | streamingContent updated |
| 5 | Event subscription processes turn_complete | Message added, streaming cleared |
| 6 | Event subscription processes error | Error state set |
| 7 | `abort()` calls agent.abort | tRPC mock called |
| 8 | `reset()` clears state | Messages empty, status idle |
| 9 | `approveToolCall()` calls tool.approve | tRPC mock called |
| 10 | `denyToolCall()` calls tool.deny | tRPC mock called |
| 11 | `listSessions()` returns sessions | Returns mock session list |
| 12 | `switchSession()` loads different session | Messages replaced |
| 13 | `newSession()` creates session | New sessionId set |

### Component rendering — deferred

Component rendering tests (using `@inkjs/testing-library`) are **deferred** until bun:test + Ink compatibility is validated. The `useServer` hook tests below cover the critical state management logic. When component tests are added, they should cover: input bar rendering, chat history display, streaming content, status bar spinner, tool call display, tool approval prompts, escape-key abort, and error state display.

### `commands.test.ts` — Command parsing

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `/help` recognized | Correct command type |
| 2 | `/sessions` recognized | Correct command type |
| 3 | Unknown command | Handled gracefully |

---

## E2E Tests (`@molf-ai/e2e`)

Integration and live tests live in `packages/e2e/`, a single workspace package that depends on all other packages. This allows clean imports via `@molf-ai/*` package names. Tests are split into subdirectories by tier:

- `tests/integration/` — Real in-process servers, mocked LLM, always run in CI
- `tests/live/` — Real Gemini API, opt-in via `MOLF_LIVE_TEST=1`

Live test files use the `.live.test.ts` suffix so they can be excluded by glob.

```json
// packages/e2e/package.json
{
  "name": "@molf-ai/e2e",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test tests/integration/",
    "test:live": "bun test tests/live/",
    "test:all": "bun test tests/"
  },
  "devDependencies": {
    "@molf-ai/test-utils": "workspace:*",
    "@molf-ai/server": "workspace:*",
    "@molf-ai/worker": "workspace:*",
    "@molf-ai/protocol": "workspace:*",
    "@molf-ai/agent-core": "workspace:*"
  }
}
```

### Shared Test Helpers

E2E tests import from two locations:

- **`@molf-ai/test-utils`** — pure helpers: `createTmpDir`, `createEnvGuard`, `getFreePort`, `mockStreamText`
- **`../helpers`** (local) — infrastructure helpers: `startTestServer`, `connectTestWorker`, `waitForEvent`

See the [Test Helpers](#test-helpers) section above for full API docs.

### `worker-connection.test.ts` — Worker-server connection

Real `startServer()` + `connectToServer()`. Validates the worker↔server connection lifecycle.

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Worker connects and registers | Server's connectionRegistry shows worker |
| 2 | Worker receives tool call via subscription | ToolDispatch sends call, worker receives it |
| 3 | Worker sends tool result back | ToolDispatch promise resolves |
| 4 | Worker `close()` disconnects cleanly | Server detects disconnect |
| 5 | Connection with wrong token fails | Rejected or auth error |

### `server-worker.test.ts` — 1 server + 1 worker + 1 client

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Worker registers, client sees it via `agent.list` | Worker listed with tools and skills |
| 2 | Client creates session bound to worker | sessionId returned |
| 3 | Client sends prompt, receives events | status_change + content_delta + turn_complete events |
| 4 | Tool call routed to worker and result returned | tool_call_start + tool_call_end events, correct result |
| 5 | Client loads session, messages persisted | Messages match what was sent |
| 6 | Client renames session | New name visible in list |
| 7 | Client deletes session | No longer in list |
| 8 | Worker disconnects mid-session | Error event or appropriate cleanup |
| 9 | Client aborts prompt | Agent stops, aborted status |

### `server-multi-worker.test.ts` — 1 server + N workers

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | 2 workers with different tools register | Both visible in `agent.list` with distinct tools |
| 2 | Session bound to worker-A dispatches tools to worker-A | Worker-B never receives calls |
| 3 | Session bound to worker-B dispatches tools to worker-B | Worker-A never receives calls |
| 4 | 3 workers + 3 concurrent sessions | Each session's tool calls go to correct worker |
| 5 | Worker-A disconnects, sessions bound to A fail gracefully | Error for A's sessions, B's sessions unaffected |
| 6 | Worker reconnects with same ID | Rejected (duplicate) — must use new connection |
| 7 | Multiple workers with overlapping tool names | Each session uses its own worker's tool |
| 8 | Concurrent tool dispatches to different workers | All resolve independently |

### `full-flow.test.ts` — End-to-end with mocked LLM

Complete flow from client prompt through server to worker tool execution and back.

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Text-only conversation (no tools) | Client receives content_delta + turn_complete |
| 2 | Single tool call flow | Client sees tool_call_start → tool_call_end → turn_complete |
| 3 | Multi-step tool loop (2 tool calls then text) | All events received in correct order |
| 4 | Tool execution error | Error propagated as tool_call_end with error content |
| 5 | Session resume: create → prompt → reload → prompt again | Second prompt has context from first |
| 6 | Worker with skills: skill tool loaded and executed | Skill content returned to LLM |
| 7 | Multiple clients subscribed to same session | Both receive same events |

### `reconnection.test.ts` — Disconnect/reconnect scenarios

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | Worker disconnect during active tool call | Pending dispatch resolves with disconnect error |
| 2 | Worker disconnect while idle | Session remains, worker removed from registry |
| 3 | Client disconnect during streaming | Server continues, no crash |
| 4 | Server restart (new server, same dataDir) | Sessions persisted on disk can be loaded |
| 5 | All workers disconnect simultaneously | All pending dispatches resolved with errors |
| 6 | New worker connects after old disconnects | New worker can take new sessions |

### `concurrent-sessions.test.ts` — Stress and race conditions

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | 5 concurrent prompts to 5 different sessions on 1 worker | All complete, no cross-contamination |
| 2 | 2 clients sending prompts to same session | Second gets AgentBusyError (CONFLICT) |
| 3 | Create + prompt + delete in rapid succession | No hanging promises or errors |
| 4 | 3 workers, 10 sessions distributed | All tool calls routed correctly |
| 5 | Rapid subscribe/unsubscribe to event bus | No memory leaks or missed events |
| 6 | Concurrent session creates | All get unique sessionIds |

### `tool-approval.test.ts` — Tool approval workflow

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `tool.approve` returns applied=true | Procedure responds correctly |
| 2 | `tool.deny` returns applied=false | Procedure responds correctly |
| 3 | `tool_approval_required` event schema validates | Event matches agentEventSchema |
| 4 | Future: approval blocks tool execution until resolved | (Placeholder for when approval is fully wired) |

---

### Live Smoke Tests

Live tests hit the real Gemini API. They are **opt-in only** — skipped unless the `MOLF_LIVE_TEST=1` env var is set. They require a valid `GEMINI_API_KEY`.

These tests exist to catch:
- API contract changes (Gemini response format, error codes)
- Auth/key configuration bugs that mocks can't detect
- Real model behavior regressions (tool calling works, streaming works)

**Convention:** Live test files use the `.live.test.ts` suffix so they can be targeted or excluded by glob.

### `live/gemini-smoke.live.test.ts` — Direct Gemini API

Skips all tests if `MOLF_LIVE_TEST` is not set. Uses real `GEMINI_API_KEY`.

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `streamText()` returns text response | Non-empty text, finishReason="stop" |
| 2 | `streamText()` with tool definition | Model calls the tool, finishReason="tool-calls" |
| 3 | Invalid API key returns auth error | Error caught, message contains "API key" or 401 |
| 4 | Model name from config resolves | No "model not found" error |

```ts
import { describe, test, expect, beforeAll } from "bun:test";
import { streamText, tool } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

const SKIP = !process.env.MOLF_LIVE_TEST;

describe.skipIf(SKIP)("Gemini live smoke", () => {
  let google: ReturnType<typeof createGoogleGenerativeAI>;

  beforeAll(() => {
    google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY! });
  });

  test("text response", async () => {
    const result = streamText({
      model: google("gemini-2.5-flash"),
      prompt: "Reply with exactly: PONG",
    });
    const chunks: string[] = [];
    for await (const event of result.fullStream) {
      if (event.type === "text-delta") chunks.push(event.textDelta);
    }
    expect(chunks.join("")).toContain("PONG");
  }, 30_000);

  test("tool call", async () => {
    const result = streamText({
      model: google("gemini-2.5-flash"),
      prompt: "What is 2 + 2? Use the calculator tool.",
      tools: {
        calculator: tool({
          description: "Add two numbers",
          parameters: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => ({ result: a + b }),
        }),
      },
    });
    let sawToolCall = false;
    for await (const event of result.fullStream) {
      if (event.type === "tool-call") sawToolCall = true;
    }
    expect(sawToolCall).toBe(true);
  }, 30_000);
});
```

### `live/agent-live.live.test.ts` — Agent with real LLM (in `packages/e2e/tests/live/`)

Full Agent class with real Gemini, no mocks. Verifies the complete prompt flow works end-to-end.

| # | Test case | What to verify |
|---|-----------|----------------|
| 1 | `Agent.prompt()` returns assistant message | Non-empty content, status returns to idle |
| 2 | Events emitted during real streaming | At least `status_change` + `content_delta` + `turn_complete` |
| 3 | Agent with tool gets tool call and loops | Tool executed, final text response received |
| 4 | `abort()` during real streaming | Agent stops, no hanging promise |

```ts
import { describe, test, expect, beforeAll } from "bun:test";

const SKIP = !process.env.MOLF_LIVE_TEST;

describe.skipIf(SKIP)("Agent live smoke", () => {
  test("simple prompt returns response", async () => {
    const { Agent } = await import("@molf-ai/agent-core");
    const agent = new Agent({
      llm: { apiKey: process.env.GEMINI_API_KEY! },
      behavior: { maxSteps: 3 },
    });

    const events: string[] = [];
    agent.onEvent((e) => events.push(e.type));

    const msg = await agent.prompt("Reply with exactly: HELLO");
    expect(msg.content).toContain("HELLO");
    expect(events).toContain("status_change");
    expect(events).toContain("turn_complete");
  }, 30_000);
});
```

---

## Test Execution

### Test tiers

Tests are organized into three tiers with separate scripts. This ensures fast feedback in development (unit tests run in seconds) while still catching real-world issues (live tests catch API regressions).

| Tier | Location | Speed | I/O | CI default | Env gate |
|------|----------|-------|-----|------------|----------|
| **Unit** | `packages/*/tests/*.test.ts` | Fast (<30s total) | None (mocked) | Yes | — |
| **Integration** | `packages/e2e/tests/integration/*.test.ts` | Medium (~60s) | Real WS servers, temp dirs | Yes | — |
| **Live** | `packages/e2e/tests/live/*.live.test.ts` | Slow (network) | Real Gemini API | No | `MOLF_LIVE_TEST=1` |

### Running tests

```bash
# All unit + integration tests (default CI gate)
bun run test

# Unit tests only (fast feedback during development)
bun run test:unit

# Integration tests only (real servers, slower)
bun run test:e2e

# Live smoke tests (requires GEMINI_API_KEY, opt-in)
MOLF_LIVE_TEST=1 bun run test:live

# Single package
bun test packages/agent-core/tests/

# Single file
bun test packages/agent-core/tests/config.test.ts

# With pattern matching
bun test --grep "ToolDispatch"

# With coverage report
bun run test:coverage
```

### package.json scripts

Add these scripts to the root `package.json`:

```json
{
  "scripts": {
    "test": "bun test --exclude '**/*.live.test.ts'",
    "test:unit": "bun test packages/agent-core/tests/ packages/protocol/tests/ packages/server/tests/ packages/worker/tests/ packages/tui/tests/",
    "test:e2e": "bun test packages/e2e/tests/integration/",
    "test:live": "bun test packages/e2e/tests/live/",
    "test:all": "bun test --exclude '**/*.live.test.ts'",
    "test:coverage": "bun test --coverage --coverage-reporter=lcov --coverage-dir=./coverage --exclude '**/*.live.test.ts'",
    "test:ci": "bun test --coverage --coverage-reporter=lcov --coverage-dir=./coverage --exclude '**/*.live.test.ts' --bail 1 && bun run scripts/check-coverage.ts"
  }
}
```

### Coverage enforcement

Coverage thresholds prevent regressions. The CI build should fail if coverage drops below these targets.

**Targets:**

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Lines | 70% | Ensures majority of code paths are exercised |
| Branches | 55% | Accounts for error-handling branches that are hard to reach in unit tests |
| Functions | 70% | Every public function should have at least one test |
| Statements | 70% | Aligns with line coverage |

**Exclusions** (paths excluded from coverage calculation):

- `packages/tui/src/components/` — Ink components are better validated via rendering tests than line coverage
- `**/index.ts` — Re-export barrels have no logic
- `**/cli.ts`, `**/bin.ts` — CLI entrypoints are wiring code, tested via integration

**Bun coverage setup:**

Bun supports `--coverage` and outputs an LCOV report via `--coverage-reporter=lcov --coverage-dir=./coverage`. Use this structured output rather than parsing text:

```bash
# Generate LCOV coverage report
bun test --coverage --coverage-reporter=lcov --coverage-dir=./coverage --exclude '**/*.live.test.ts'
```

```ts
// scripts/check-coverage.ts
// Parse the LCOV report from coverage/lcov.info and enforce thresholds.
// Exit with code 1 if any metric falls below threshold.

import fs from "node:fs";

const THRESHOLDS = { lines: 70, branches: 55, functions: 70, statements: 70 };
const lcov = fs.readFileSync("coverage/lcov.info", "utf-8");

// Parse LCOV format: LH (lines hit), LF (lines found), BRH/BRF (branches), FNH/FNF (functions)
// Calculate percentages and compare against THRESHOLDS
// process.exit(1) if any metric is below threshold
```

If Bun adds native threshold configuration, this script can be removed. The LCOV approach is stable across Bun versions and compatible with CI coverage reporting tools (Codecov, Coveralls, etc.).

### Test isolation requirements

- Each test file must be self-contained: set up in `beforeAll`/`beforeEach`, tear down in `afterAll`/`afterEach`
- Temp directories cleaned up via `createTmpDir()` from `@molf-ai/test-utils`
- WebSocket servers closed after each test file (otherwise ports leak)
- No shared mutable state between test files
- Environment variables saved/restored via `createEnvGuard()` from `@molf-ai/test-utils`
- Integration tests use `port: 0` to avoid port conflicts across parallel files

### Estimated test case count

| Package | Unit tests | Integration tests | Live tests | Total |
|---------|-----------|-------------------|------------|-------|
| agent-core | ~60 | — | — | 60 |
| protocol | ~20 | — | — | 20 |
| server | ~89 | — | — | 89 |
| worker | ~28 | — | — | 28 |
| tui | ~16 | — | — | 16 |
| e2e | — | ~50 | ~8 | 58 |
| **Total** | **~213** | **~50** | **~8** | **~271** |

---

## Implementation Order

Implement tests in dependency order so earlier tests validate foundations used by later tests:

1. **`packages/test-utils/`** — `@molf-ai/test-utils` pure helpers (tmpdir, env-guard, port, mock-stream) — zero `@molf-ai/*` deps, everything else depends on these
2. **`protocol/tests/`** — Schema validation (no dependencies beyond helpers)
3. **`agent-core/tests/config.test.ts`**, **`session.test.ts`**, **`tool-registry.test.ts`** — Pure data classes
4. **`agent-core/tests/agent*.test.ts`** — Agent with mocked LLM (depends on session, config, registry)
5. **`agent-core/tests/tools/`** — Built-in tools (real filesystem in temp dirs)
6. **`server/tests/`** — Server components: auth → config → session-mgr → event-bus → tool-dispatch → connection-registry → agent-runner (including `buildRemoteTools`, `mapAgentEvent`) → router (including auth middleware) → server
7. **`worker/tests/`** — Worker components: identity → skills → tool-executor → cli (unit tests only)
8. **`tui/tests/`** — `useServer` hook state management + command parsing (component rendering deferred)
9. **`packages/e2e/helpers/`** + **`packages/e2e/tests/integration/`** — E2E infrastructure helpers (test-server, test-worker, wait-for-event) + integration tests including worker-connection
10. **`packages/e2e/tests/live/`** — Live smoke tests (last — validates real API after everything else passes)
11. **Coverage script + CI wiring** — `scripts/check-coverage.ts`, package.json scripts, CI pipeline config

---

## Key Mocking Patterns

### Mocking `streamText` from `"ai"`

```ts
import { mock } from "bun:test";

// Mock before importing Agent
mock.module("ai", () => ({
  streamText: (opts) => {
    // Return controlled stream events
    const events = [
      { type: "text-delta", text: "Hello" },
      { type: "finish", finishReason: "stop" },
    ];
    return {
      fullStream: (async function* () {
        for (const e of events) yield e;
      })(),
    };
  },
  tool: (def) => def,         // pass-through
  jsonSchema: (s) => s,       // pass-through
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => "mock-model",
}));
```

### tRPC caller for router testing

```ts
import { createCallerFactory } from "@trpc/server";
import { appRouter } from "../src/router.js";

const createCaller = createCallerFactory(appRouter);
const caller = createCaller({
  token: "valid-token",
  clientId: "test-client",
  sessionMgr,
  connectionRegistry,
  agentRunner,
  eventBus,
  toolDispatch,
  dataDir: tmpDir,
});

// Now call procedures directly:
const result = await caller.session.list();
```

### Real server for integration tests (e2e)

```ts
// In packages/e2e/tests/integration/*.test.ts
import { startTestServer, type TestServer } from "../../helpers/index.js";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
  // server.url, server.token, server.port available
});

afterAll(async () => {
  await server.cleanup();
});
```
