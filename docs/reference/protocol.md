# Protocol Reference

All communication in Molf Assistant uses oRPC over WebSocket. This page documents every oRPC procedure, event type, and core type.

## Connection

- **URL**: `wss://host:port` (TLS enabled by default; `ws://` when TLS is disabled)
- **Default**: `wss://127.0.0.1:7600`
- **Auth**: `Authorization: Bearer {token}` header on WebSocket handshake
- **Max payload**: 110 MB
- **Keep-alive**: ping every 30s, pong timeout 10s

The `protocol` package provides `createAuthWebSocket` (with bearer token + TLS options) and `createUnauthWebSocket` (for the pairing flow) as WebSocket helpers.

## Router: `session`

Session lifecycle management.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `create` | mutation | `{ workerId: uuid, workspaceId: string, name?: string, metadata?: object }` | `{ sessionId, name, workerId, createdAt, metadata? }` | Create a new session |
| `list` | query | `{ sessionId?, name?, workerId?, active?, metadata?, limit? (1-200), offset? }?` | `{ sessions: SessionListItem[], total }` | List sessions with optional filters and pagination |
| `load` | mutation | `{ sessionId }` | `SessionFile` | Load full session with messages |
| `delete` | mutation | `{ sessionId }` | `void` | Delete a session |
| `rename` | mutation | `{ sessionId, name }` | `void` | Rename a session |

## Router: `agent`

LLM interaction and event streaming.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `list` | query | -- | `WorkerInfo[]` | List all known workers with tool/skill info |
| `prompt` | mutation | `{ sessionId, text, model?, fileRefs? (max 10) }` | `void` | Send a prompt (fire-and-forget; results arrive via events) |
| `shellExec` | mutation | `{ sessionId, command, saveToSession? }` | `{ output, exitCode, truncated, outputPath? }` | Execute a shell command directly (bypasses approval) |
| `abort` | mutation | `{ sessionId }` | `void` | Abort the current agent turn |
| `status` | query | `{ sessionId }` | `{ status: AgentStatus }` | Get current agent status |
| `onEvents` | subscription | `{ sessionId }` | `AgentEvent` stream | Subscribe to agent events (replays pending approval requests on connect) |

## Router: `tool`

Tool approval management.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `list` | query | `{ sessionId }` | `ToolDefinition[]` | List available tools for a session |
| `approve` | mutation | `{ approvalId, always? }` | `{ applied }` | Approve a pending tool call (`always: true` adds a runtime always-approve rule) |
| `deny` | mutation | `{ approvalId, feedback? }` | `{ applied }` | Deny a pending tool call with optional feedback |

## Router: `worker`

Worker registration, state sync, and dispatch subscriptions.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `register` | mutation | `{ workerId, name, tools, skills?, agents?, metadata? }` | `{ workerId, plugins? }` | Register a worker (returns plugin specifiers to load) |
| `rename` | mutation | `{ workerId, name }` | `void` | Rename a worker |
| `syncState` | mutation | `{ workerId, tools?, skills?, agents?, metadata? }` | `void` | Sync updated worker state to server |
| `onToolCall` | subscription | `{ workerId }` | `ToolCallRequest` stream | Subscribe to tool call dispatch |
| `toolResult` | mutation | `{ toolCallId, output, error?, meta?, attachments? }` | `void` | Return a tool call result |
| `onUpload` | subscription | `{ workerId }` | `UploadRequest` stream | Subscribe to file upload dispatch |
| `uploadResult` | mutation | `{ uploadId, path, size, error? }` | `void` | Return an upload result |
| `fetchUpload` | query | `{ uploadId }` | `{ file: File }` | Fetch a staged upload file by ID |
| `onFsRead` | subscription | `{ workerId }` | `FsReadRequest` stream | Subscribe to filesystem read dispatch |
| `fsReadResult` | mutation | `{ requestId, content, size, encoding, error? }` | `void` | Return a filesystem read result |

## Router: `fs`

Filesystem operations: reading truncated tool output and uploading file attachments.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `read` | mutation | `{ sessionId, outputId?, path?, encoding?: "utf-8" \| "binary" }` | `{ content: string \| File, size, encoding }` | Read a file by output ID or path (30s timeout). When `encoding: "binary"`, returns a `File` object. |
| `upload` | mutation | `{ sessionId, file: File }` | `{ path, mimeType, size }` | Upload a file attachment (100 MB max, 30s timeout). File is staged on the server and dispatched to the worker. |

## Router: `provider`

LLM provider and model discovery.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `listProviders` | query | -- | `ProviderListItem[]` | List available providers with model counts |
| `listModels` | query | `{ providerID? }` | `ModelInfo[]` | List models, optionally filtered by provider |

## Router: `workspace`

Workspace management. Workspaces group sessions and carry per-workspace config.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `list` | query | `{ workerId }` | `Workspace[]` | List workspaces for a worker |
| `create` | mutation | `{ workerId, name }` | `{ workspace, sessionId }` | Create a workspace (also creates the first session) |
| `rename` | mutation | `{ workerId, workspaceId, name }` | `void` | Rename a workspace |
| `setConfig` | mutation | `{ workerId, workspaceId, config: WorkspaceConfig }` | `void` | Update workspace config (e.g., model override) |
| `sessions` | query | `{ workerId, workspaceId }` | `SessionListItem[]` | List sessions in a workspace |
| `ensureDefault` | mutation | `{ workerId }` | `Workspace` | Get or create the default workspace |
| `onEvents` | subscription | `{ workerId, workspaceId }` | `WorkspaceEvent` stream | Subscribe to workspace events |

## Router: `auth`

Authentication and pairing.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `createPairingCode` | mutation | -- | `{ code }` | Generate a 6-digit pairing code (requires auth) |
| `redeemPairingCode` | mutation | `{ code }` | `{ apiKey, name }` | Redeem a pairing code for an API key (public, rate-limited) |
| `listApiKeys` | query | -- | `{ keys: { id, name, createdAt }[] }` | List issued API keys |
| `revokeApiKey` | mutation | `{ id }` | `void` | Revoke an API key |

## Router: `plugin`

Dynamic plugin route dispatch.

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `list` | query | -- | `{ name, routes }[]` | List loaded plugins and their routes |
| `query` | query | `{ plugin, method, input }` | `unknown` | Call a plugin query route |
| `mutate` | mutation | `{ plugin, method, input }` | `unknown` | Call a plugin mutation route |

## Event Types

Events are emitted by the AgentRunner through the EventBus and delivered to clients via the `agent.onEvents` subscription.

| Type | Fields | Description |
|------|--------|-------------|
| `status_change` | `status: AgentStatus` | Agent status transition |
| `content_delta` | `delta: string, content: string` | Incremental text from the LLM (`delta` is the new chunk, `content` is the accumulated text) |
| `tool_call_start` | `toolCallId, toolName, arguments` | LLM requested a tool call |
| `tool_call_end` | `toolCallId, toolName, result, truncated?, outputId?` | Tool call completed (`outputId` allows full output retrieval via `fs.read`) |
| `turn_complete` | `message: SessionMessage` | Agent turn finished |
| `error` | `code, message, context?` | Error during agent execution |
| `tool_approval_required` | `approvalId, toolName, arguments, sessionId` | Tool call needs approval (respond with `tool.approve` or `tool.deny`) |
| `context_compacted` | `summaryMessageId` | Context was summarized to fit within the model's context window |
| `subagent_event` | `agentType, sessionId, event: BaseAgentEvent` | Wraps any base event from a subagent session |

## Core Types

### AgentStatus

```typescript
type AgentStatus = "idle" | "streaming" | "executing_tool" | "error" | "aborted";
```

### SessionMessage

```typescript
interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: FileRef[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
  synthetic?: boolean;   // injected by system, not by LLM
  summary?: boolean;     // marks summary checkpoint messages
  usage?: { inputTokens, outputTokens, reasoningTokens?, cacheReadTokens?, cacheWriteTokens? };
  model?: string;        // "provider/model" format
}
```

### FileRef

```typescript
interface FileRef {
  path: string;       // relative to workdir
  mimeType: string;
  filename?: string;  // original filename
  size?: number;      // bytes
}
```

### ToolResultEnvelope

```typescript
interface ToolResultEnvelope {
  output: string;
  error?: string;
  meta?: {
    truncated?: boolean;
    outputId?: string;
    instructionFiles?: { path: string; content: string }[];
    exitCode?: number;
    outputPath?: string;
  };
  attachments?: Attachment[];
}
```

### BehaviorConfig

```typescript
interface BehaviorConfig {
  systemPrompt?: string;
  maxSteps: number;          // default: 10
  contextPruning?: boolean;
  temperature?: number;
}
```

### CompactPermission

```typescript
type CompactPermission = Record<
  string,  // tool name or "*" for catch-all
  "allow" | "deny" | "ask" | Record<string, "allow" | "deny" | "ask">
>;
```

### WorkspaceConfig

```typescript
interface WorkspaceConfig {
  model?: string;  // "provider/model" format; undefined = server default
}
```

### ConnectionEntry

```typescript
interface ConnectionEntry {
  role: "worker" | "client";
  id: string;
  name: string;
  connectedAt: number;
}
```

### WorkerMetadata

```typescript
interface WorkerMetadata {
  workdir?: string;
  agentsDoc?: string;
  [key: string]: unknown;
}
```

### CronSchedule

```typescript
type CronSchedule =
  | { kind: "at"; at: number }                                    // one-shot (Unix ms)
  | { kind: "every"; interval_ms: number; anchor_ms?: number }   // repeating
  | { kind: "cron"; expr: string; tz?: string };                  // cron expression
```

### ServerConfig

```typescript
interface ServerConfig {
  host: string;        // default: "127.0.0.1"
  port: number;        // default: 7600
  dataDir: string;     // default: "."
  model: string;       // "provider/model" format
  tls: boolean;        // default: true
  tlsCertPath?: string;
  tlsKeyPath?: string;
}
```

## See also

- [Architecture](./architecture.md) -- package graph and key abstractions
- [Plugins](./plugins.md) -- plugin routes and hook system
- [Security](/guide/configuration#tls-configuration) -- TLS and auth configuration
