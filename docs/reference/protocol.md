# Protocol Reference

Molf uses [tRPC v11](https://trpc.io/) over WebSocket for all communication between clients, server, and workers.

## WebSocket Connection

**URL format:**

```
ws://{host}:{port}?token={authToken}&clientId={uuid}&name={clientName}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `token` | Yes | Auth token (printed by server on startup) |
| `clientId` | Yes | UUID identifying the connecting client or worker |
| `name` | Yes | Human-readable name for the connection |

**Connection settings:**

| Setting | Value |
|---------|-------|
| Max payload | 50 MB (`50 * 1024 * 1024` bytes) |
| Keep-alive ping interval | 30 seconds |
| Pong wait timeout | 10 seconds |
| Default port | 7600 |

**Authentication:** The server hashes the provided token with SHA-256 and compares it against the stored hash in `{dataDir}/server.json`. All tRPC procedures use the `authedProcedure` middleware, which rejects requests without a valid token.

## Session Router (`session.*`)

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `session.create` | mutation | `{ name?, workerId, config?, metadata? }` | `{ sessionId, name, workerId, createdAt, metadata? }` | Create a new session bound to a worker |
| `session.list` | query | `{ sessionId?, name?, workerId?, active?, metadata?, limit?, offset? }?` | `{ sessions, total }` | List sessions with optional filters |
| `session.load` | mutation | `{ sessionId }` | `{ sessionId, name, workerId, messages }` | Load a session with full message history |
| `session.delete` | mutation | `{ sessionId }` | `{ deleted: boolean }` | Delete a session from disk |
| `session.rename` | mutation | `{ sessionId, name }` | `{ renamed: boolean }` | Rename a session |

**Key notes:**

- `workerId` must be a valid UUID of a registered worker
- `session.list` supports pagination via `limit` (1-200) and `offset`
- `session.list` can filter by `metadata` fields (e.g., `{ client: "telegram" }`)
- `session.load` returns the full message history; use `session.list` for lightweight browsing
- `config` allows per-session LLM and behavior overrides (see [Core Types](#core-types))

## Agent Router (`agent.*`)

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `agent.list` | query | *(none)* | `{ workers: WorkerInfo[] }` | List all connected workers with tools and skills |
| `agent.prompt` | mutation | `{ sessionId, text, fileRefs? }` | `{ messageId }` | Submit a prompt to the agent |
| `agent.upload` | mutation | `{ sessionId, data, filename, mimeType }` | `{ path, mimeType, size }` | Upload a file to the session's worker |
| `agent.shellExec` | mutation | `{ sessionId, command, saveToSession? }` | `{ stdout, stderr, exitCode, stdoutTruncated?, stderrTruncated?, stdoutOutputPath?, stderrOutputPath? }` | Run a shell command directly on the worker, bypassing the LLM |
| `agent.abort` | mutation | `{ sessionId }` | `{ aborted: boolean }` | Abort the running agent turn |
| `agent.status` | query | `{ sessionId }` | `{ status, sessionId }` | Get the current agent status |
| `agent.onEvents` | subscription | `{ sessionId }` | `AgentEvent` (stream) | Subscribe to real-time agent events |

**Key notes:**

- `agent.prompt` is fire-and-forget: it returns `{ messageId }` immediately. Results arrive via `agent.onEvents` subscription.
- Subscribe to `agent.onEvents` **before** calling `agent.prompt` to avoid missing events.
- `fileRefs` is an array of `{ path, mimeType }` (max 10 items), referencing files previously uploaded via `agent.upload`.
- `agent.upload` accepts base64-encoded `data` with a max size of 15 MB. The file is saved on the worker at `.molf/uploads/{uuid}-{filename}`.
- `agent.shellExec` dispatches the command through `ToolDispatch` (same path as LLM tool calls) using a `se_` prefixed `toolCallId`. The worker must have `shell_exec` in its tool list; if not, the server returns `PRECONDITION_FAILED`. The result is synchronous (up to the 120s `ToolDispatch` timeout).
- `saveToSession` controls whether the shell result is injected into the session message history as a **synthetic message** (marked with `synthetic: true`). When `true`, the server checks that the agent is not busy (`CONFLICT` if it is) and injects user + tool messages into the session after execution. When `false` or omitted, the result is returned to the client but not stored. TUI uses `!` for saved, `!!` for fire-and-forget.
- If stdout or stderr exceed truncation thresholds (2000 lines or 50KB), the output is truncated and the full content is saved on the worker at `.molf/tool-output/`. The `stdoutOutputPath` / `stderrOutputPath` fields point to these files.
- `agent.abort` cancels the current agent turn. The agent emits a `status_change` event with status `"aborted"`.

## Tool Router (`tool.*`)

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `tool.list` | query | `{ sessionId }` | `{ tools: Array<{ name, description, workerId }> }` | List available tools for a session's worker |
| `tool.approve` | mutation | `{ sessionId, toolCallId }` | `{ applied: boolean }` | Approve a pending tool call |
| `tool.deny` | mutation | `{ sessionId, toolCallId }` | `{ applied: boolean }` | Deny a pending tool call |

**Key notes:**

- Tool approval is infrastructure for a future approval workflow. Currently, tool calls are auto-approved.
- When the approval workflow is active, the server emits a `tool_approval_required` event. The client must respond with `tool.approve` or `tool.deny` before execution proceeds.

## Worker Router (`worker.*`)

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `worker.register` | mutation | `{ workerId, name, tools, skills?, metadata? }` | `{ workerId }` | Register a worker with its tools and skills |
| `worker.rename` | mutation | `{ workerId, name }` | `{ renamed: boolean }` | Rename a connected worker |
| `worker.onToolCall` | subscription | `{ workerId }` | `ToolCallRequest` (stream) | Subscribe to tool call assignments |
| `worker.toolResult` | mutation | `{ toolCallId, result, error? }` | `{ received: boolean }` | Return a tool call result |
| `worker.onUpload` | subscription | `{ workerId }` | `UploadRequest` (stream) | Subscribe to file upload assignments |
| `worker.uploadResult` | mutation | `{ uploadId, path, size, error? }` | `{ received: boolean }` | Return a file upload result |
| `worker.onFsRead` | subscription | `{ workerId }` | `FsReadRequest` (stream) | Subscribe to filesystem read requests |
| `worker.fsReadResult` | mutation | `{ requestId, content, size, encoding, error? }` | `{ received: boolean }` | Return a filesystem read result |

**Key notes:**

- `workerId` must be a UUID. Workers persist their UUID in `{workdir}/.molf/worker.json` for reconnection.
- `tools` is an array of `WorkerToolInfo` objects (`{ name, description, inputSchema }`).
- `skills` is an optional array of `WorkerSkillInfo` objects (`{ name, description, content }`).
- `metadata` includes `workdir` (working directory path) and `agentsDoc` (contents of AGENTS.md).
- `worker.toolResult` accepts `result` as JSON and an optional `error` string.
- Tool result mutations are retried up to 3 times with 1-second base delay on failure.
- `worker.onFsRead` enables the server to request file reads from the worker without going through tool execution. Used by the server to retrieve truncated tool output files from `.molf/tool-output/`. Timeout: 30 seconds.
- `worker.fsReadResult` returns the file content (UTF-8 or base64-encoded) back to the server.

## FS Router (`fs.*`)

| Procedure | Type | Input | Output | Description |
|-----------|------|-------|--------|-------------|
| `fs.read` | mutation | `{ sessionId, outputId?, path?, encoding? }` | `{ content, size, encoding }` | Read a file from the session's worker |

**Key notes:**

- Either `outputId` or `path` must be provided (validated via schema refinement).
- `outputId` references a tool call ID whose output was truncated — the server resolves this to the full output file on the worker at `.molf/tool-output/`.
- `path` allows direct file reads from the worker's filesystem.
- `encoding` in the response is `"utf-8"` or `"base64"`.
- Timeout: 30 seconds (built into FsDispatch).
- Used by clients to retrieve full tool output when `tool_call_end` events include `truncated: true` and `outputId`.

## Agent Events

Clients receive these events via the `agent.onEvents` subscription:

| Event Type | Key Fields | When Emitted |
|------------|------------|------------|
| `status_change` | `status: AgentStatus` | Agent status transitions (idle, streaming, executing_tool, error, aborted) |
| `content_delta` | `delta: string`, `content: string` | Each chunk of streamed text from the LLM. `delta` is the new chunk, `content` is the accumulated text. |
| `tool_call_start` | `toolCallId`, `toolName`, `arguments` | LLM requests a tool call. `arguments` is a JSON string. |
| `tool_call_end` | `toolCallId`, `toolName`, `result` | Tool call completed. `result` is the tool's output as a string. |
| `turn_complete` | `message: SessionMessage` | Agent turn finished. Contains the final assistant message with all tool calls. |
| `error` | `code`, `message`, `context?` | An error occurred during agent execution. |
| `tool_approval_required` | `toolCallId`, `toolName`, `arguments`, `sessionId` | A tool call is pending approval. Respond with `tool.approve` or `tool.deny`. |
| `context_compacted` | `summaryMessageId` | Emitted after context summarization. `summaryMessageId` points to the assistant message containing the generated summary. Follows `turn_complete`, when context usage ≥80%. |

### AgentEvent Type Definition

```typescript
type AgentEvent =
  | { type: "status_change"; status: AgentStatus }
  | { type: "content_delta"; delta: string; content: string }
  | { type: "tool_call_start"; toolCallId: string; toolName: string; arguments: string }
  | { type: "tool_call_end"; toolCallId: string; toolName: string; result: string }
  | { type: "turn_complete"; message: SessionMessage }
  | { type: "error"; code: string; message: string; context?: Record<string, unknown> }
  | { type: "tool_approval_required"; toolCallId: string; toolName: string; arguments: string; sessionId: string }
  | { type: "context_compacted"; summaryMessageId: string }
```

### AgentStatus

```typescript
type AgentStatus = "idle" | "streaming" | "executing_tool" | "error" | "aborted";
```

| Status | Meaning |
|--------|---------|
| `idle` | No active turn. Ready for a new prompt. |
| `streaming` | LLM is generating text. |
| `executing_tool` | A tool call is being executed by a worker. |
| `error` | An error occurred. |
| `aborted` | The turn was cancelled via `agent.abort`. |

## Core Types

### SessionMessage

```typescript
interface SessionMessage {
  id: string;                   // UUID
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: FileRef[];      // Uploaded files (user messages)
  toolCalls?: ToolCall[];       // Tool calls made (assistant messages)
  toolCallId?: string;          // ID of the tool call this result is for (tool messages)
  toolName?: string;            // Name of the tool (tool messages)
  timestamp: number;            // Unix timestamp (ms)
  synthetic?: boolean;          // Injected by the system (e.g. shell exec), not by the LLM
  summary?: boolean;            // Marks summary checkpoint messages (injected by automatic context summarization)
  usage?: { inputTokens: number; outputTokens: number }; // Token usage from the LLM response (assistant messages)
}
```

### ToolCall

```typescript
interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  providerMetadata?: Record<string, Record<string, unknown>>;
}
```

### FileRef

Stored in `SessionMessage.attachments` for uploaded files:

```typescript
interface FileRef {
  path: string;        // Relative to workdir: .molf/uploads/{uuid}-{name}
  mimeType: string;
  filename?: string;   // Original filename
  size?: number;       // Bytes
}
```

### BinaryResult

Returned by tools (e.g., `read_file`) for binary files:

```typescript
interface BinaryResult {
  type: "binary";
  data: string;       // Base64-encoded
  mimeType: string;
  path: string;
  size: number;
}
```

### ToolCallRequest

Sent from server to worker via `worker.onToolCall`:

```typescript
interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}
```

### FsReadRequest

Sent from server to worker via `worker.onFsRead`:

```typescript
interface FsReadRequest {
  requestId: string;
  outputId?: string;   // toolCallId identifying the output file
  path?: string;       // Direct file path (alternative to outputId)
}
```

### FsReadResult

Returned by worker via `worker.fsReadResult`:

```typescript
interface FsReadResult {
  requestId: string;
  content: string;     // File content (UTF-8 or base64)
  size: number;        // Content size in bytes
  encoding: "utf-8" | "base64";
  error?: string;      // Set if the read failed
}
```

### UploadRequest

Sent from server to worker via `worker.onUpload`:

```typescript
interface UploadRequest {
  uploadId: string;
  data: string;        // Base64-encoded
  filename: string;
  mimeType: string;
}
```

### WorkerInfo

```typescript
interface WorkerInfo {
  workerId: string;
  name: string;
  tools: WorkerToolInfo[];
  skills: WorkerSkillInfo[];
  connected: boolean;
  metadata?: WorkerMetadata;
}
```

### WorkerToolInfo

```typescript
interface WorkerToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
}
```

### WorkerSkillInfo

```typescript
interface WorkerSkillInfo {
  name: string;
  description: string;
  content: string;     // Full skill instructions (body of SKILL.md)
}
```

### WorkerMetadata

```typescript
interface WorkerMetadata {
  workdir?: string;           // Worker's working directory
  agentsDoc?: string;         // Contents of AGENTS.md / CLAUDE.md
  [key: string]: unknown;
}
```

### ServerConfig

```typescript
interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  llm: {
    provider: string;
    model: string;
  };
}
```

### LLMConfig

```typescript
interface LLMConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  contextWindow?: number;
}
```

### BehaviorConfig

```typescript
interface BehaviorConfig {
  systemPrompt?: string;
  maxSteps: number;          // Default: 10
  contextPruning?: boolean;
}
```

## Error Codes

### Synchronous Errors (tRPC)

These are returned as tRPC errors with standard HTTP-style codes:

| Error | tRPC Code | When |
|-------|-----------|------|
| `SessionNotFoundError` | `NOT_FOUND` | Session ID does not exist |
| `AgentBusyError` | `CONFLICT` | Prompt submitted while agent is already running |
| `WorkerDisconnectedError` | `PRECONDITION_FAILED` | Session's worker is not connected |
| `SessionCorruptError` | `INTERNAL_SERVER_ERROR` | Session file is corrupt or unreadable |
| Unauthorized | `UNAUTHORIZED` | Missing or invalid auth token |

### Asynchronous Errors (Events)

Errors during agent execution are emitted as `error` events:

```typescript
{ type: "error"; code: string; message: string; context?: Record<string, unknown> }
```

Common error codes include:

| Code | When |
|------|------|
| `WORKER_DISCONNECTED` | Worker disconnected during tool execution |
| `TOOL_TIMEOUT` | Tool execution exceeded timeout (default 120s) |
| `TURN_TIMEOUT` | Agent turn exceeded 10-minute timeout |
| `LLM_ERROR` | LLM provider returned an error |
| `CONTEXT_LENGTH` | Context window exceeded (auto-pruning attempted) |

## See Also

- [Building a Custom Client](/clients/custom-client) — practical guide with code examples for using this protocol
- [Architecture](/reference/architecture) — message flow diagrams showing how these procedures are used
- [Troubleshooting](/reference/troubleshooting) — common error codes and their fixes
