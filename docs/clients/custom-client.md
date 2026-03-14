# Building a Custom Client

Any WebSocket client that speaks the oRPC wire protocol can connect to a Molf server. This page covers the connection setup, core API workflow, event handling, and tool approval -- everything needed to build a client from scratch.

## Connecting

### URL and Authentication

The server listens on `wss://host:port` (TLS by default, port 7600). Authentication is sent via the `Authorization: Bearer {token}` header on the WebSocket handshake. Two query parameters identify the client:

| Parameter | Description |
|-----------|-------------|
| `clientId` | A UUID identifying this client instance |
| `name` | A human-readable name (e.g. `"my-app"`) |

### TLS with Self-Signed Certificates

The server auto-generates a self-signed EC certificate by default. Clients connecting from Node.js need to handle this -- either:

- Provide a CA file via `--tls-ca` / `MOLF_TLS_CA` (if using a proper CA)
- Use the `createAuthWebSocket` helper from `@molf-ai/protocol`, which accepts TLS options like `ca`, `rejectUnauthorized`, and `checkServerIdentity`
- Use `probeServerCert` from `@molf-ai/protocol` to implement TOFU (Trust On First Use) -- probe the server's certificate, display the fingerprint, and pin it for future connections

### oRPC Client Setup

Using `@orpc/client` with the `ws` package:

```typescript
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { createAuthWebSocket } from "@molf-ai/protocol";
import type { RpcClient } from "@molf-ai/protocol";

const token = process.env.MOLF_TOKEN!;
const serverUrl = "wss://127.0.0.1:7600";

// createAuthWebSocket returns a WebSocket subclass that injects
// the Authorization header and applies TLS options
const AuthWebSocket = createAuthWebSocket(token, {
  // For self-signed certs, pass TLS opts here:
  // ca: readFileSync("/path/to/ca.pem"),
  // rejectUnauthorized: false,  // only for development
});

const url = new URL(serverUrl);
url.searchParams.set("clientId", crypto.randomUUID());
url.searchParams.set("name", "my-client");

const ws = new AuthWebSocket(url.toString());
const link = new RPCLink({ websocket: ws });
const client = createORPCClient(link) as RpcClient;
```

For unauthenticated connections (e.g. during a pairing flow), use `createUnauthWebSocket` instead.

## Core API Workflow

A typical client session follows these steps:

```
1. Ensure workspace  ->  2. Create/load session  ->  3. Subscribe to events
      ->  4. Send prompts  ->  5. Handle tool approvals
```

### Step 1: Ensure a Workspace

Workspaces group sessions and carry per-workspace configuration (like model overrides).

```typescript
const { workspace, sessionId } = await client.workspace.ensureDefault({
  workerId,
});
```

Or create a named workspace:

```typescript
const { workspace, sessionId } = await client.workspace.create({
  workerId,
  name: "My Project",
});
```

### Step 2: Create or Load a Session

Create a new session within a workspace:

```typescript
const created = await client.session.create({
  workerId,
  workspaceId: workspace.id,
});
const sessionId = created.sessionId;
```

Or load an existing session:

```typescript
const loaded = await client.session.load({ sessionId: "existing-id" });
// loaded.messages contains the full message history
```

### Step 3: Subscribe to Events

Subscribe **before** sending a prompt to avoid missing early events. oRPC subscriptions return async iterators:

```typescript
const iter = await client.agent.onEvents({ sessionId });

// Consume events in a loop (typically in a background task)
(async () => {
  for await (const event of iter) {
    // Handle events (see Event Types below)
  }
})();
```

### Step 4: Send a Prompt

```typescript
await client.agent.prompt({
  sessionId,
  text: "List files in the current directory",
  // Optional overrides:
  // model: "anthropic/claude-sonnet-4-20250514",
  // fileRefs: [{ path: "/path/to/file", mimeType: "image/png" }],
});
```

The prompt call is fire-and-forget -- it returns immediately. Results arrive through the event subscription.

### Step 5: Handle Tool Approvals

When the agent makes a tool call that requires approval, a `tool_approval_required` event is emitted. Respond with one of:

```typescript
// Approve once
await client.tool.approve({ sessionId, approvalId });

// Always approve this tool+pattern (persisted to permissions.jsonc)
await client.tool.approve({ sessionId, approvalId, always: true });

// Deny with optional feedback (sent back to the LLM as the tool result)
await client.tool.deny({ sessionId, approvalId, feedback: "Too risky" });
```

Both `tool.approve` and `tool.deny` return `{ applied: boolean }`. If `applied` is `false`, the approval was already resolved or the agent was aborted.

## Event Types

The `agent.onEvents` subscription emits 9 event types:

| Event | Key Fields | Description |
|-------|------------|-------------|
| `status_change` | `status` | Agent status changed: `idle`, `streaming`, `executing_tool`, `error`, `aborted` |
| `content_delta` | `delta`, `content` | Streaming text chunk (`delta` is the new fragment, `content` is accumulated) |
| `tool_call_start` | `toolName`, `arguments`, `toolCallId` | Tool execution began |
| `tool_call_end` | `toolCallId`, `result` | Tool execution finished |
| `turn_complete` | `message` | Full assistant message with all tool calls and content |
| `error` | `code`, `message` | Error during agent execution |
| `tool_approval_required` | `approvalId`, `toolName`, `arguments`, `sessionId` | Tool call needs user approval |
| `context_compacted` | `summaryMessageId` | Context was automatically summarized (informational, no action needed) |
| `subagent_event` | `agentType`, `sessionId`, `event` | Wrapper around a child agent's event |

### Handling Subagent Events

When the agent spawns a subagent via the `task` tool, the child's events arrive wrapped in `subagent_event`:

```typescript
if (event.type === "subagent_event") {
  const inner = event.event;
  console.log(`[@${event.agentType}] ${inner.type}`);

  // Tool approvals from subagents must be handled the same way
  if (inner.type === "tool_approval_required") {
    await client.tool.approve({
      sessionId: inner.sessionId,
      approvalId: inner.approvalId,
    });
  }
}
```

### Reconnect Replay

When a client reconnects and re-subscribes to `agent.onEvents`, the server automatically replays any pending `tool_approval_required` events for that session.

## Key Procedures

The server exposes 9 oRPC routers. Here are the procedures most relevant to client development:

| Router | Procedure | Type | Description |
|--------|-----------|------|-------------|
| `session` | `create` | mutation | Create a session (`workerId` + `workspaceId`) |
| `session` | `load` | mutation | Load a session and its messages |
| `session` | `list` | query | List sessions (pagination 1-200) |
| `session` | `delete` | mutation | Delete a session |
| `session` | `rename` | mutation | Rename a session |
| `agent` | `list` | query | List workers with tools, skills, agents |
| `agent` | `prompt` | mutation | Send a prompt (fire-and-forget) |
| `agent` | `onEvents` | subscription | Stream agent events for a session |
| `agent` | `abort` | mutation | Cancel the running agent |
| `agent` | `status` | query | Get current agent status for a session |
| `agent` | `shellExec` | mutation | Run a shell command on the worker |
| `fs` | `upload` | mutation | Upload a file (100 MB max, File object) |
| `tool` | `list` | query | List available tools |
| `tool` | `approve` | mutation | Approve a pending tool call |
| `tool` | `deny` | mutation | Deny a pending tool call |
| `workspace` | `ensureDefault` | mutation | Get or create the default workspace |
| `workspace` | `create` | mutation | Create a workspace (also creates a first session) |
| `workspace` | `setConfig` | mutation | Set workspace config (e.g. model) |
| `workspace` | `onEvents` | subscription | Stream workspace events |
| `provider` | `listModels` | query | List available models |
| `auth` | `createPairingCode` | mutation | Generate a 6-digit pairing code |
| `auth` | `redeemPairingCode` | mutation | Exchange code for API key (public, rate-limited) |

For the complete API, see [Protocol Reference](../reference/protocol.md).

## Example: Minimal Client

A complete Node.js script that connects, creates a session, sends a prompt, and prints the response:

```typescript
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import WebSocket from "ws";
import type { RpcClient } from "@molf-ai/protocol";

const token = process.env.MOLF_TOKEN!;
const url = `ws://127.0.0.1:7600?clientId=${crypto.randomUUID()}&name=example`;

// Note: this example uses ws:// (no TLS) for simplicity.
// In production, use wss:// with createAuthWebSocket.
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
const link = new RPCLink({ websocket: ws });
const client = createORPCClient(link) as RpcClient;

async function main() {
  const { workers } = await client.agent.list();
  const worker = workers.find((w) => w.connected);
  if (!worker) throw new Error("No workers connected");

  const { workspace } = await client.workspace.ensureDefault({
    workerId: worker.workerId,
  });

  const session = await client.session.create({
    workerId: worker.workerId,
    workspaceId: workspace.id,
  });

  const iter = await client.agent.onEvents({ sessionId: session.sessionId });

  await client.agent.prompt({ sessionId: session.sessionId, text: "Hello! What tools do you have available?" });

  for await (const event of iter) {
    if (event.type === "content_delta") {
      process.stdout.write(event.delta);
    } else if (event.type === "turn_complete") {
      console.log("\n--- Done ---");
      break;
    } else if (event.type === "error") {
      console.error(`\nError: ${event.message}`);
      break;
    }
  }
  ws.close();
}

main().catch(console.error);
```

## See Also

- [Protocol Reference](../reference/protocol.md) -- complete oRPC API with all 9 routers, event types, and core types
- [Architecture](../reference/architecture.md) -- message flow and system design
- [Terminal TUI](./terminal-tui.md) -- reference client implementation (Ink + React)
- [Telegram Bot](./telegram.md) -- another client implementation (grammY)
- [Tool Approval](../server/tool-approval.md) -- how approval rules are evaluated
