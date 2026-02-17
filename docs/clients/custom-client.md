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
});
```

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

## Tool Approval

When a tool call requires approval, the server emits a `tool_approval_required` event:

```typescript
{
  type: "tool_approval_required",
  toolCallId: "...",
  toolName: "shell_exec",
  arguments: '{"command":"rm -rf /tmp/test"}',
  sessionId: "..."
}
```

Respond with approve or deny:

```typescript
// Approve
await trpc.tool.approve.mutate({
  sessionId: session.sessionId,
  toolCallId: event.toolCallId,
});

// Deny
await trpc.tool.deny.mutate({
  sessionId: session.sessionId,
  toolCallId: event.toolCallId,
});
```

::: info
Tool approval is currently auto-approved by default. The protocol infrastructure is in place for clients that want to implement approval workflows.
:::

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

## See Also

- [Protocol Reference](/reference/protocol) — complete tRPC API with all procedures, event types, and error codes
- [Architecture](/reference/architecture) — message flow diagrams and event system details
- [Terminal TUI](/clients/terminal-tui) — reference client implementation
- [Telegram Bot](/clients/telegram) — another client implementation example
