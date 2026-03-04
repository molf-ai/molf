# Building a Custom Client

## Overview

Molf uses **tRPC v11 over WebSocket** for all client-server communication. Any language or framework that can open a WebSocket connection and speak the tRPC wire protocol can be a Molf client.

This page walks through the essential steps: connecting, creating sessions, sending prompts, and handling streaming events. For the complete API reference, see the [Protocol Reference](/reference/protocol).

## Connecting to the Server

### WebSocket URL

```
ws://{host}:{port}?token={authToken}&clientId={uuid}&name={clientName}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `token` | Yes | Auth token printed by the server on startup |
| `clientId` | Yes | A UUID identifying this client instance |
| `name` | Yes | A human-readable name for this client |

### TypeScript Example

Using `@trpc/client` with the `ws` package:

```typescript
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import type { AppRouter } from "@molf-ai/server";

const token = process.env.MOLF_TOKEN!;
const clientId = randomUUID();

const wsClient = createWSClient({
  url: `ws://127.0.0.1:7600?token=${token}&clientId=${clientId}&name=my-client`,
  WebSocket,
});

const trpc = createTRPCClient<AppRouter>({
  links: [wsLink({ client: wsClient })],
});
```

## Session Workflow

A typical client follows this flow:

```
List workers → Create session → Subscribe to events → Send prompt → Handle events
```

### 1. List Workers

Find available workers and their tools:

```typescript
const { workers } = await trpc.agent.list.query();

const worker = workers.find((w) => w.connected);
if (!worker) throw new Error("No workers connected");

console.log(`Using worker: ${worker.name} (${worker.workerId})`);
console.log(`Tools: ${worker.tools.map((t) => t.name).join(", ")}`);

// Workers also report available subagent types
console.log(`Agents: ${worker.agents.map((a) => a.name).join(", ")}`);
```

### 2. Create a Session

Sessions are bound to a specific worker at creation time:

```typescript
const session = await trpc.session.create.mutate({
  workerId: worker.workerId,
  name: "My Session",
});

console.log(`Session: ${session.sessionId}`);
```

Sessions belong to workspaces. If you don't specify a `workspaceId`, the session is added to the worker's default workspace:

```typescript
const session = await trpc.session.create.mutate({
  workerId: worker.workerId,
  workspaceId: "workspace-id", // optional — defaults to the worker's default workspace
});
```

### 3. Resume an Existing Session

To resume a previous session, load it by ID:

```typescript
const loaded = await trpc.session.load.mutate({
  sessionId: "existing-session-id",
});

// loaded.messages contains the full message history
```

You can also list sessions with filters:

```typescript
const { sessions } = await trpc.session.list.query({
  workerId: worker.workerId,
  limit: 10,
});
```

### 4. Send a Prompt and Receive Events

**Subscribe to events before sending the prompt** — otherwise you may miss early events like `status_change`.

```typescript
// Subscribe to events
const subscription = trpc.agent.onEvents.subscribe(
  { sessionId: session.sessionId },
  {
    onData(event) {
      switch (event.type) {
        case "status_change":
          // Agent status: "idle" | "streaming" | "executing_tool" | "error" | "aborted"
          console.log(`Status: ${event.status}`);
          break;

        case "content_delta":
          // Streaming text — event.delta is the new chunk, event.content is accumulated
          process.stdout.write(event.delta);
          break;

        case "tool_call_start":
          console.log(`\nTool: ${event.toolName}(${event.arguments})`);
          break;

        case "tool_call_end":
          console.log(`Result: ${event.result}`);
          break;

        case "turn_complete":
          // Full assistant message available in event.message
          console.log("\n--- Turn complete ---");
          break;

        case "error":
          console.error(`Error [${event.code}]: ${event.message}`);
          break;

        case "context_compacted":
          console.log(`Context summarized (checkpoint: ${event.summaryMessageId})`);
          break;

        case "subagent_event":
          // Unwrap the inner event
          const inner = event.event;
          console.log(`[@${event.agentType}] ${inner.type}`);

          // Extract approval events from subagents — handle identically
          if (inner.type === "tool_approval_required") {
            // Same approval handling as direct events
          }
          break;

        case "tool_approval_required":
          // Handle tool approval (see below)
          break;
      }
    },
    onError(err) {
      console.error("Subscription error:", err);
    },
  },
);

// Send prompt
const { messageId } = await trpc.agent.prompt.mutate({
  sessionId: session.sessionId,
  text: "List files in the current directory",
  modelId: "anthropic/claude-sonnet-4-20250514", // optional: override model for this prompt
});
```

The `subagent_event` wraps any base agent event with metadata about which subagent produced it. The `event.event` field contains the inner event (same types as above), and `event.agentType` / `event.sessionId` identify the subagent. Tool approval events from subagents must be handled identically to direct approvals — extract the inner `tool_approval_required` event and respond with `tool.approve` / `tool.deny` using the inner event's `approvalId`.

The `context_compacted` event is emitted after `turn_complete` when the server automatically summarizes older session context. The `summaryMessageId` references the assistant message containing the summary. This event is informational — no client action is required.

### 5. Abort a Running Agent

```typescript
await trpc.agent.abort.mutate({ sessionId: session.sessionId });
```

## File Uploads

Upload a file to the worker, then reference it in a prompt:

```typescript
import { readFileSync } from "fs";

const fileData = readFileSync("screenshot.png");

// 1. Upload the file (max 15MB)
const upload = await trpc.agent.upload.mutate({
  sessionId: session.sessionId,
  data: fileData.toString("base64"),
  filename: "screenshot.png",
  mimeType: "image/png",
});

// 2. Reference it in a prompt
await trpc.agent.prompt.mutate({
  sessionId: session.sessionId,
  text: "What's in this screenshot?",
  fileRefs: [{ path: upload.path, mimeType: upload.mimeType }],
});
```

Up to 10 file references can be included in a single prompt.

## Model Selection

### Listing Available Models

Query available providers and models:

```typescript
// List all providers
const providers = await trpc.provider.listProviders.query();
// Returns: [{ id: "anthropic", name: "Anthropic", modelCount: 5 }, ...]

// List all models (optionally filter by provider)
const models = await trpc.provider.listModels.query();
const anthropicModels = await trpc.provider.listModels.query({ provider: "anthropic" });
```

Each model includes: `id`, `name`, `providerID`, `capabilities`, `cost`, `limit`, and `status`.

### Switching Models Per-Workspace

Model configuration is per-workspace, not per-session. Use `workspace.setConfig` to set or clear a model override:

```typescript
// Set a model for this workspace
await trpc.workspace.setConfig.mutate({
  workerId: worker.workerId,
  workspaceId: "workspace-id",
  config: { model: "openai/gpt-4o" },
});

// Clear the override (revert to server default)
await trpc.workspace.setConfig.mutate({
  workerId: worker.workerId,
  workspaceId: "workspace-id",
  config: { model: undefined },
});
```

### Per-Prompt Model Override

Pass `model` on individual prompts:

```typescript
await trpc.agent.prompt.mutate({
  sessionId: session.sessionId,
  text: "Analyze this code",
  modelId: "anthropic/claude-sonnet-4-20250514",
});
```

### Resolution Priority

When resolving which model to use, the server checks in order:
1. Per-prompt `modelId` parameter (if provided)
2. Workspace config model (set via `workspace.setConfig`)
3. Server default model (from `MOLF_DEFAULT_MODEL` env var or config)

## Tool Approval

When a tool call requires user confirmation, the server emits a `tool_approval_required` event through the `agent.onEvents` subscription:

```typescript
{
  type: "tool_approval_required",
  approvalId: "session-abc:1a2b3c4d",
  toolName: "shell_exec",
  arguments: '{"command":"rm -rf /tmp/test"}',
  sessionId: "session-abc"
}
```

The `approvalId` uniquely identifies this pending approval request. Use it in one of the four response options below.

### Approve Once

Allow this single tool call to proceed:

```typescript
await trpc.tool.approve.mutate({
  sessionId: event.sessionId,
  approvalId: event.approvalId,
});
```

### Always Approve

Allow this tool+pattern going forward. The pattern is persisted to the worker's `permissions.jsonc` file and future matching tool calls will be auto-approved:

```typescript
await trpc.tool.approve.mutate({
  sessionId: event.sessionId,
  approvalId: event.approvalId,
  always: true,
});
```

When "always approve" is applied, the server re-evaluates all other pending approval requests for the same session. Any that now match an allow rule are auto-resolved (cascade resolution).

### Deny with Optional Feedback

Reject this tool call. The optional `feedback` string is returned to the LLM as the tool result, so the agent can adjust its approach:

```typescript
await trpc.tool.deny.mutate({
  sessionId: event.sessionId,
  approvalId: event.approvalId,
  feedback: "Too dangerous",
});
```

### Checking the Result

Both `tool.approve` and `tool.deny` return `{ applied: boolean }`. A result of `applied: false` means the approval was already resolved or cancelled (e.g., the agent was aborted). Clients should check this value before updating their UI state.

### Reconnect Replay

When a client reconnects and re-subscribes to `agent.onEvents`, the server automatically replays any pending `tool_approval_required` events for that session. This ensures the client can re-render approval prompts after a temporary disconnection without any special handling.

See [Tool Approval](/server/tool-approval) for details on how approval rules are evaluated, default rules, and per-worker ruleset customization.

## Example: Minimal Node.js Client

A complete example that connects, creates a session, sends a prompt, and prints the streaming response:

```typescript
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import type { AppRouter } from "@molf-ai/server";

const token = process.env.MOLF_TOKEN!;

const wsClient = createWSClient({
  url: `ws://127.0.0.1:7600?token=${token}&clientId=${randomUUID()}&name=example`,
  WebSocket,
});

const trpc = createTRPCClient<AppRouter>({
  links: [wsLink({ client: wsClient })],
});

async function main() {
  // Find a connected worker
  const { workers } = await trpc.agent.list.query();
  const worker = workers.find((w) => w.connected);
  if (!worker) throw new Error("No workers connected");

  // Create a session
  const session = await trpc.session.create.mutate({
    workerId: worker.workerId,
  });

  // Subscribe to events
  const done = new Promise<void>((resolve) => {
    trpc.agent.onEvents.subscribe(
      { sessionId: session.sessionId },
      {
        onData(event) {
          if (event.type === "content_delta") {
            process.stdout.write(event.delta);
          }
          if (event.type === "turn_complete") {
            console.log();
            resolve();
          }
          if (event.type === "error") {
            console.error(`\nError: ${event.message}`);
            resolve();
          }
        },
      },
    );
  });

  // Send a prompt
  await trpc.agent.prompt.mutate({
    sessionId: session.sessionId,
    text: "Hello! What tools do you have available?",
  });

  // Wait for completion
  await done;

  // Clean up
  wsClient.close();
}

main().catch(console.error);
```

## Workspaces

Workspaces group sessions and hold configuration (like model overrides). The `workspace` router provides 7 procedures:

```typescript
// List workspaces for a worker
const workspaces = await trpc.workspace.list.query({ workerId: worker.workerId });

// Create a workspace (also creates its first session)
const { workspace, sessionId } = await trpc.workspace.create.mutate({
  workerId: worker.workerId,
  name: "My Workspace",
});

// Set workspace config (e.g. model override)
await trpc.workspace.setConfig.mutate({
  workerId: worker.workerId,
  workspaceId: workspace.id,
  config: { model: "google/gemini-2.0-flash" },
});

// List sessions in a workspace
const sessions = await trpc.workspace.sessions.query({ workerId: worker.workerId, workspaceId: workspace.id });

// Subscribe to workspace events (session_created, config_changed, cron_fired)
trpc.workspace.onEvents.subscribe(
  { workerId: worker.workerId, workspaceId: workspace.id },
  {
    onData(event) {
      console.log(`Workspace event: ${event.type}`);
    },
  },
);
```

Other procedures: `workspace.rename`, `workspace.ensureDefault`.

## Cron Jobs

Schedule recurring or one-shot prompts via the `cron` router (4 procedures):

```typescript
// Add a cron job — three schedule kinds: "at" (one-shot), "every" (interval), "cron" (expression)
await trpc.cron.add.mutate({
  workerId: worker.workerId,
  workspaceId: workspace.id,
  name: "Health check",
  schedule: { kind: "every", interval_ms: 3600000 }, // 1 hour
  payload: { kind: "agent_turn", message: "Check system health and report" },
});

// List cron jobs
const jobs = await trpc.cron.list.query({
  workerId: worker.workerId,
  workspaceId: workspace.id,
});

// Update a job's schedule or payload
await trpc.cron.update.mutate({
  workerId: worker.workerId,
  workspaceId: workspace.id,
  jobId: jobs[0].id,
  schedule: { kind: "cron", expr: "0 9 * * 1-5" },
});

// Remove a job
await trpc.cron.remove.mutate({
  workerId: worker.workerId,
  workspaceId: workspace.id,
  jobId: jobs[0].id,
});
```

When a cron job fires, it emits a `cron_fired` workspace event, auto-creates a session, and prompts the agent. `at` jobs are one-shot and auto-removed after firing.

## See Also

- [Protocol Reference](/reference/protocol) — complete tRPC API with all procedures, event types, and error codes
- [Architecture](/reference/architecture) — message flow diagrams and event system details
- [Terminal TUI](/clients/terminal-tui) — reference client implementation
- [Telegram Bot](/clients/telegram) — another client implementation example
