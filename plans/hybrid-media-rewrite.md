# Hybrid Media Rewrite Plan

## Goal

Rewrite media handling so uploaded files live on the **worker** (not server), are accessible to the agent via `read_file` and `shell_exec`, and images are also inlined in LLM messages. Replace server-side `MediaStore` with a lightweight TTL cache for inline images only.

## Current State

- Media stored on **server** at `data/media/{uuid}.ext` via `MediaStore`
- ALL attachments (image, PDF, video) inlined to LLM as `ImagePart`/`FilePart`
- Worker has zero media awareness
- `read_file` is text-only (no binary support)
- Client sends base64 in `agentPromptInput.attachments` with the prompt
- On session resume, server re-loads ALL media bytes from disk and re-inlines

## Problems

1. Large files (video, audio, big PDFs) wastefully inlined to LLM context
2. Media not accessible to agent as files on disk (can't use in scripts, tools)
3. No way for agent to reference uploaded files in later turns via `read_file`
4. On session resume, ALL media bytes re-loaded even when not needed

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| File storage location | Worker at `{workdir}/.molf/uploads/` | Files accessible via agent tools (read_file, shell_exec). Natural owner of workspace files. |
| Upload flow | Upload-first via tRPC `agent.upload` mutation, then prompt with file references | All-tRPC. No HTTP layer. Decouples upload from messaging. |
| Global file size limit | 15MB for all uploads | Single limit, simple. Covers images, PDFs, audio. |
| Inline rule | Images only (`image/*`) — inlined AND uploaded | LLMs process images natively. Images go to both LLM (inline) and worker (file). |
| Non-image files | Upload to worker, text reference in LLM message | "User attached: .molf/uploads/abc-report.pdf (2.3MB)" — LLM calls `read_file` when needed. |
| Server image cache | `InlineMediaCache` with 8h TTL, 200MB max | Enables image re-inlining on session resume without fetching from worker. Bounded memory. |
| File naming | `{full-uuid}-{sanitized_filename}` | Full UUID for unpredictability. `path.basename()` + character allowlist for safety. |
| Inlining decision | Runtime, not persisted | No `inlined` boolean on `FileRef`. Server checks: is image AND in cache? |
| Upload dispatch | Dedicated `worker.onUpload` / `worker.uploadResult` subscription pair | Clean separation from tool dispatch. No synthetic tools. |
| Binary in tool results | `media` field in `workerToolResultInput` | First-class field through ToolExecutor → ToolDispatch → AgentRunner. No magic markers. |
| `read_file` binary support | Images, PDFs, audio (no video), max 15MB | Video excluded — no LLM can process it. |
| `FileRef` definition | Once in `packages/protocol`, imported everywhere | Single source of truth. |
| TUI client | No upload support for now | Telegram only. TUI can be added later. |

## New Data Flow

### Upload Flow

```
Client                     Server                        Worker
  │                          │                              │
  │  agent.upload({          │                              │
  │    sessionId,            │                              │
  │    data: base64,         │                              │
  │    filename, mimeType    │                              │
  │  })                      │                              │
  │─────────────────────────>│                              │
  │  (tRPC mutation, same    │ 1. Auth (authedProcedure)    │
  │   WS connection)         │ 2. Validate size ≤15MB       │
  │                          │ 3. Look up session → worker  │
  │                          │ 4. If image: cache bytes in  │
  │                          │    InlineMediaCache          │
  │                          │ 5. Forward to worker via     │
  │                          │    UploadDispatch            │
  │                          │─────────────────────────────>│
  │                          │                              │ Sanitize filename
  │                          │                              │ Save to
  │                          │                              │ .molf/uploads/{uuid}-{name}
  │                          │          { path, size }      │
  │                          │<─────────────────────────────│
  │  { path, mimeType,      │                              │
  │    size }                │                              │
  │<─────────────────────────│                              │
```

### Prompt Flow

```
Client                     Server                        LLM
  │                          │                              │
  │  agent.prompt({          │                              │
  │    sessionId,            │                              │
  │    text,                 │                              │
  │    fileRefs: [{path,     │                              │
  │      mimeType}]          │                              │
  │  })                      │                              │
  │─────────────────────────>│                              │
  │                          │ For each fileRef:            │
  │                          │ ┌─ image + in cache:         │
  │                          │ │  Inline as ImagePart       │
  │                          │ ├─ image + cache miss:       │
  │                          │ │  TextPart: "Image was at   │
  │                          │ │  {path}. Use read_file."   │
  │                          │ ├─ non-image:                │
  │                          │ │  TextPart: "User attached: │
  │                          │ │  {path} ({type})"          │
  │                          │ └───────────────────────────>│
  │                          │       streamText(messages)   │
```

### read_file with Binary Support

```
LLM calls read_file({path: ".molf/uploads/abc-photo.png"})
  │
  ├─ Worker detects: image extension (.png)
  │  Checks size ≤15MB
  │  Reads as Uint8Array
  │  ToolExecutor returns: { result: {path, mimeType, size}, media: [{data, mimeType}] }
  │
  ├─ Worker sends toolResult with explicit media[] field
  │
  ├─ Server receives tool result with media[]
  │  Builds ToolResultPart: [TextPart(metadata), ImagePart(decoded bytes)]
  │
  └─ LLM sees the image in the tool result
```

### Session Resume

```
Server loads session JSON
  │
  ├─ User message with image FileRef:
  │  ├─ Runtime check: is image AND in InlineMediaCache?
  │  ├─ Cache HIT: re-inline as ImagePart ✓
  │  └─ Cache MISS: TextPart "Image was at {path}. Use read_file to view."
  │
  ├─ User message with non-image FileRef:
  │  └─ Always text reference. No change needed.
  │
  └─ Tool message with media:
     └─ Ephemeral (not persisted). Agent can read_file again.
```

## Type Architecture

```
Client (Telegram)           Server                        Agent-Core (Session/LLM)
───────────────────         ──────────────────────        ──────────────────────────
agent.upload() returns      FileRef                       ResolvedAttachment
{ path, mimeType, size }    { path: string,               { data: Uint8Array,
                      →      mimeType: string,       →     mimeType: string,
                              filename?: string,            filename?: string }
                              size?: number }             (for inlined images only)
                         persisted in session JSON      in-memory for LLM calls

                         InlineMediaCache               FileRef
                         { buffer: Uint8Array,           { path, mimeType, ... }
                           mimeType, savedAt }           (for non-inlined files,
                         (8h TTL, 200MB max)              passed as text reference)
```

`FileRef` defined ONCE in `packages/protocol/src/types.ts`. No `inlined` boolean — inlining is a runtime decision.

`media` flows as a first-class field: `ToolExecutor.execute() → workerToolResultInput → ToolDispatch → AgentRunner`. No magic markers.

---

## Phase 1: Protocol — New Types & Schemas

**Files:** `packages/protocol/src/types.ts`, `packages/protocol/src/schemas.ts`, `packages/protocol/src/helpers.ts`, `packages/protocol/src/index.ts`

### New type: FileRef (replaces MediaRef)

```ts
/** Stored in SessionMessage — references uploaded file on worker.
 *  Single source of truth, imported by all packages. */
interface FileRef {
  path: string;           // relative to workdir: .molf/uploads/{uuid}-{name}
  mimeType: string;
  filename?: string;      // original filename (before UUID prefix)
  size?: number;          // bytes
}
```

No `inlined` boolean. Whether to inline is a runtime decision (is image AND in cache?).

### Update SessionMessage

```ts
interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: FileRef[];     // ← was MediaRef[], now FileRef[]
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
}
```

### New and updated schemas

Replace `mediaRefSchema` with `fileRefSchema`:
```ts
const fileRefSchema = z.object({
  path: z.string().min(1),
  mimeType: z.string().min(1),
  filename: z.string().optional(),
  size: z.number().optional(),
});
```

Replace `attachmentSchema` with `fileRefInputSchema`:
```ts
const fileRefInputSchema = z.object({
  path: z.string().min(1),
  mimeType: z.string().min(1),
});
```

Update `agentPromptInput` — `fileRefs` replaces `attachments`:
```ts
const agentPromptInput = z.object({
  sessionId: z.string(),
  text: z.string(),
  fileRefs: z.array(fileRefInputSchema).max(10).optional(),
});
```

New `agent.upload` mutation schema:
```ts
const agentUploadInput = z.object({
  sessionId: z.string(),
  data: z.string().min(1),        // base64
  filename: z.string().min(1),
  mimeType: z.string().min(1),
});

const agentUploadOutput = z.object({
  path: z.string(),
  mimeType: z.string(),
  size: z.number(),
});
```

Add `media` to `workerToolResultInput`:
```ts
const workerToolResultInput = z.object({
  toolCallId: z.string(),
  result: z.unknown(),
  error: z.string().optional(),
  media: z.array(z.object({
    data: z.string().min(1),  // base64
    mimeType: z.string().min(1),
  })).optional(),
});
```

Upload dispatch schemas (server→worker):
```ts
const workerUploadRequestSchema = z.object({
  uploadId: z.string(),
  data: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
});

const workerUploadResultInput = z.object({
  uploadId: z.string(),
  path: z.string(),
  size: z.number(),
  error: z.string().optional(),
});
```

Update `MAX_ATTACHMENT_BYTES` to 15MB:
```ts
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
```

### Helpers

- `lastMessagePreview()`: update to work with `FileRef` instead of `MediaRef`

### Delete

- `mediaRefSchema`, `attachmentSchema`, `Attachment` type, `MediaRef` type

### Tests

- `fileRefSchema` validation (valid path, empty path rejection)
- `workerToolResultInput` with and without `media` field
- `agentPromptInput` with `fileRefs` instead of `attachments`
- `agentUploadInput` validation
- `lastMessagePreview()` with `FileRef`

---

## Phase 2: Worker — File Storage & read_file Binary Support

**Files:** new `packages/worker/src/uploads.ts`, `packages/worker/src/tool-executor.ts`, `packages/worker/src/connection.ts`, `packages/agent-core/src/tools/read-file.ts`

### Worker file storage

```ts
// packages/worker/src/uploads.ts (new file)
import { resolve, join, basename } from "path";

const UPLOADS_DIR = ".molf/uploads";

export async function saveUploadedFile(
  workdir: string,
  buffer: Uint8Array,
  filename: string,
): Promise<{ path: string; size: number }> {
  const uploadsDir = resolve(workdir, UPLOADS_DIR);
  await Bun.mkdir(uploadsDir, { recursive: true });

  // Sanitize filename: strip path components, restrict characters
  const sanitized = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeName = `${crypto.randomUUID()}-${sanitized}`;
  const absPath = resolve(uploadsDir, safeName);

  // Defense in depth: verify resolved path is within uploads dir
  if (!absPath.startsWith(resolve(uploadsDir) + "/")) {
    throw new Error("Path traversal detected");
  }

  await Bun.write(absPath, buffer);

  return {
    path: join(UPLOADS_DIR, safeName),
    size: buffer.byteLength,
  };
}
```

### Worker upload subscription

Dedicated `worker.onUpload` subscription + `worker.uploadResult` mutation. Mirrors the existing `onToolCall` / `toolResult` pattern:

```ts
// In packages/worker/src/connection.ts — add alongside onToolCall subscription
const uploadSub = trpc.worker.onUpload.subscribe(
  { workerId },
  {
    onData: async (request) => {
      try {
        const buffer = new Uint8Array(Buffer.from(request.data, "base64"));
        const { path, size } = await saveUploadedFile(workdir, buffer, request.filename);
        await trpc.worker.uploadResult.mutate({ uploadId: request.uploadId, path, size });
      } catch (err) {
        await trpc.worker.uploadResult.mutate({
          uploadId: request.uploadId,
          path: "",
          size: 0,
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    },
  },
);
```

### read_file — binary file detection

Update `packages/agent-core/src/tools/read-file.ts`:

```ts
const MAX_BINARY_READ_BYTES = 15 * 1024 * 1024; // 15MB, matches upload limit

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "ogg", "wav", "m4a", "flac", "aac"]);

// Video intentionally excluded — no LLM can process video in tool results.

const EXTENSION_TO_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  svg: "image/svg+xml", pdf: "application/pdf",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
};

function getMediaType(path: string): { type: "image" | "document" | "audio"; mimeType: string } | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(ext)) return { type: "image", mimeType: EXTENSION_TO_MIME[ext] ?? `image/${ext}` };
  if (PDF_EXTENSIONS.has(ext)) return { type: "document", mimeType: "application/pdf" };
  if (AUDIO_EXTENSIONS.has(ext)) return { type: "audio", mimeType: EXTENSION_TO_MIME[ext] ?? `audio/${ext}` };
  return null;
}
```

Updated execute:
```ts
execute: async ({ path, startLine, endLine }) => {
  const file = Bun.file(path);
  if (!await file.exists()) return { error: `File not found: ${path}` };

  const mediaType = getMediaType(path);
  if (mediaType) {
    const stat = await file.stat();
    if (stat.size > MAX_BINARY_READ_BYTES) {
      return {
        error: `File too large for inline viewing (${(stat.size / (1024*1024)).toFixed(1)}MB, max 15MB). Use shell_exec to process.`,
      };
    }

    const buffer = new Uint8Array(await file.arrayBuffer());
    const base64 = Buffer.from(buffer).toString("base64");
    return {
      result: { path, mimeType: mediaType.mimeType, size: buffer.byteLength, type: mediaType.type },
      media: [{ data: base64, mimeType: mediaType.mimeType }],
    };
  }

  // Text file — existing behavior unchanged
  const raw = await file.text();
  // ... rest of existing text logic ...
}
```

### ToolExecutor — extract `media` from tool results

`media` is a first-class field, not a magic marker:

```ts
async execute(toolName: string, args: Record<string, unknown>): Promise<{
  result: unknown;
  error?: string;
  media?: Array<{ data: string; mimeType: string }>;
}> {
  const rawResult = await tool.execute(resolvedArgs);

  // Tools return { result, media } for binary content
  if (rawResult && typeof rawResult === "object" && "media" in rawResult && "result" in rawResult) {
    const { media, result } = rawResult as { result: unknown; media: Array<{ data: string; mimeType: string }> };
    return { result, media };
  }
  return { result: rawResult };
}
```

### Worker connection — pass `media` through

```ts
onData: async (request) => {
  const { result, error, media } = await toolExecutor.execute(request.toolName, request.args);
  await trpc.worker.toolResult.mutate({
    toolCallId: request.toolCallId,
    result,
    error,
    ...(media?.length ? { media } : {}),
  });
}
```

### Tests (Phase 2)

- `saveUploadedFile()`: correct directory, full UUID, correct relative path
- `saveUploadedFile()`: sanitizes filename (strips path separators, special chars)
- `saveUploadedFile()`: rejects path traversal attempts
- Worker `onUpload` subscription: saves file, returns path + size
- Worker `onUpload` subscription: handles errors gracefully
- `read_file` with image: returns metadata + `media`
- `read_file` with PDF: returns metadata + `media`
- `read_file` with video: returns text error (excluded)
- `read_file` with file >15MB: returns size error
- `read_file` with text file: unchanged (no `media`)
- `ToolExecutor.execute()` extracts `media` from `{ result, media }` return

---

## Phase 3: Server — InlineMediaCache, Upload Mutation & Integration

**Files:** new `packages/server/src/inline-media-cache.ts`, new `packages/server/src/upload-dispatch.ts`, modify `packages/server/src/server.ts`, `packages/server/src/router.ts`, `packages/server/src/agent-runner.ts`, `packages/server/src/tool-dispatch.ts`, `packages/server/src/session-mgr.ts`

### InlineMediaCache (new file, replaces MediaStore)

```ts
interface CacheEntry {
  buffer: Uint8Array;
  mimeType: string;
  savedAt: number;
}

const TTL_MS = 8 * 60 * 60 * 1000;       // 8 hours
const MAX_BYTES = 200 * 1024 * 1024;      // 200MB total
const PRUNE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export class InlineMediaCache {
  private cache = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private pruneTimer: Timer;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
  }

  save(path: string, buffer: Uint8Array, mimeType: string): void {
    this.delete(path); // remove existing if any

    // LRU eviction if over budget
    while (this.totalBytes + buffer.byteLength > MAX_BYTES && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value!;
      this.delete(oldestKey);
    }

    this.cache.set(path, { buffer, mimeType, savedAt: Date.now() });
    this.totalBytes += buffer.byteLength;
  }

  load(path: string): { buffer: Uint8Array; mimeType: string } | null {
    const entry = this.cache.get(path);
    if (!entry) return null;
    if (Date.now() - entry.savedAt > TTL_MS) {
      this.delete(path);
      return null;
    }
    return { buffer: entry.buffer, mimeType: entry.mimeType };
  }

  delete(path: string): void {
    const entry = this.cache.get(path);
    if (entry) {
      this.totalBytes -= entry.buffer.byteLength;
      this.cache.delete(path);
    }
  }

  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.savedAt > TTL_MS) {
        this.delete(key);
        removed++;
      }
    }
    return removed;
  }

  close(): void {
    clearInterval(this.pruneTimer);
    this.cache.clear();
    this.totalBytes = 0;
  }
}
```

Hardcoded TTL, bounded memory (200MB, LRU eviction), periodic pruning. In-memory only — on restart, cache is cold. Files are still on worker, accessible via `read_file`.

### UploadDispatch (new file)

Mirrors `ToolDispatch` but simpler (no approval flow):

```ts
export class UploadDispatch {
  private pending = new Map<string, (r: { path: string; size: number; error?: string }) => void>();
  private listeners = new Map<string, (req: UploadRequest) => void>();

  subscribeWorker(workerId: string): AsyncGenerator<UploadRequest> { /* same pattern as ToolDispatch */ }
  dispatch(workerId: string, req: UploadRequest): Promise<{ path: string; size: number; error?: string }> { /* ... */ }
  resolveUpload(uploadId: string, result: { path: string; size: number; error?: string }): boolean { /* ... */ }
  workerDisconnected(workerId: string): void { /* resolve pending with error */ }
}
```

### Server setup — add new modules

No architecture changes. Pure WebSocket server stays as-is:

```ts
export function startServer(config: ServerConfig): ServerInstance {
  // ... existing setup ...
  const inlineMediaCache = new InlineMediaCache();
  const uploadDispatch = new UploadDispatch();

  // Pass to router context and AgentRunner
  // ...

  return {
    wss,
    close: () => {
      inlineMediaCache.close();
      wss.close();
      // ... existing cleanup ...
    },
    _ctx: { ..., uploadDispatch, inlineMediaCache },
  };
}
```

### Router — `agent.upload` mutation

```ts
const UPLOAD_TIMEOUT_MS = 30_000;

upload: authedProcedure
  .input(agentUploadInput)
  .output(agentUploadOutput)
  .mutation(async ({ input, ctx }) => {
    // 1. Validate size
    const rawSize = Math.floor(input.data.length * 3 / 4);
    if (rawSize > MAX_ATTACHMENT_BYTES) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "File too large (max 15MB)" });
    }

    // 2. Look up session → worker
    const session = ctx.sessionMgr.load(input.sessionId);
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    const worker = ctx.connectionRegistry.getWorker(session.workerId);
    if (!worker) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Worker not connected" });

    // 3. Forward to worker via UploadDispatch (with timeout)
    const uploadId = `upload_${crypto.randomUUID().slice(0, 8)}`;
    let result: { path: string; size: number; error?: string };
    try {
      result = await Promise.race([
        ctx.uploadDispatch.dispatch(session.workerId, {
          uploadId,
          data: input.data,
          filename: input.filename,
          mimeType: input.mimeType,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Upload timeout")), UPLOAD_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      throw new TRPCError({
        code: "TIMEOUT",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }

    if (result.error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error });
    }

    // 4. Cache image bytes for inline
    if (input.mimeType.startsWith("image/")) {
      const buffer = Buffer.from(input.data, "base64");
      ctx.inlineMediaCache.save(result.path, new Uint8Array(buffer), input.mimeType);
    }

    return { path: result.path, mimeType: input.mimeType, size: result.size };
  }),
```

### Router — worker upload procedures

```ts
onUpload: authedProcedure
  .subscription(async function* ({ ctx }) {
    yield* ctx.uploadDispatch.subscribeWorker(ctx.workerId);
  }),

uploadResult: authedProcedure
  .input(workerUploadResultInput)
  .mutation(async ({ input, ctx }) => {
    ctx.uploadDispatch.resolveUpload(input.uploadId, {
      path: input.path,
      size: input.size,
      error: input.error,
    });
    return { received: true };
  }),
```

### Router — pass media + fileRefs through

```ts
// workerRouter.toolResult — pass media:
ctx.toolDispatch.resolveToolCall(input.toolCallId, input.result, input.error, input.media);

// agentRouter.prompt — pass fileRefs:
return await ctx.agentRunner.prompt(input.sessionId, input.text, input.fileRefs);
```

### ToolDispatch — pass media through

```ts
type ToolCallResolver = (r: { result: unknown; error?: string; media?: Array<{ data: string; mimeType: string }> }) => void;

resolveToolCall(toolCallId: string, result: unknown, error?: string, media?: ...): boolean {
  const resolver = this.pending.get(toolCallId);
  if (!resolver) return false;
  this.pending.delete(toolCallId);
  this.pendingWorker.delete(toolCallId);
  resolver({ result, error, media });
  return true;
}
```

### AgentRunner.prompt() rewrite

```ts
async prompt(
  sessionId: string,
  text: string,
  fileRefs?: Array<{ path: string; mimeType: string }>,
): Promise<{ messageId: string }> {
  // Persist user message with FileRefs
  const persistRefs: FileRef[] | undefined = fileRefs?.map(ref => ({
    path: ref.path,
    mimeType: ref.mimeType,
  }));

  const userMessage: SessionMessage = {
    id: messageId, role: "user", content: text, timestamp: Date.now(),
    ...(persistRefs?.length ? { attachments: persistRefs } : {}),
  };
  this.sessionMgr.addMessage(sessionId, userMessage);

  // Build agent session with runtime-resolved media
  const resolvedMessages = this.resolveSessionMessages(sessionFile.messages);
  const session = Session.deserialize({ messages: resolvedMessages });
  // ... create agent, register tools ...
}
```

### resolveSessionMessages() — runtime inlining

```ts
private resolveSessionMessages(messages: SessionMessage[]): AgentCoreSessionMessage[] {
  return messages.map((msg) => {
    const base = { id: msg.id, role: msg.role, content: msg.content, timestamp: msg.timestamp,
      ...(msg.toolCalls && { toolCalls: msg.toolCalls }),
      ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
      ...(msg.toolName && { toolName: msg.toolName }),
    };

    if (!msg.attachments?.length) return base;

    const inlined: ResolvedAttachment[] = [];
    const fileRefs: FileRef[] = [];

    for (const ref of msg.attachments) {
      if (ref.mimeType.startsWith("image/")) {
        const cached = this.inlineMediaCache.load(ref.path);
        if (cached) {
          inlined.push({ data: cached.buffer, mimeType: ref.mimeType });
          continue;
        }
      }
      fileRefs.push(ref);
    }

    if (inlined.length > 0) base.attachments = inlined;
    if (fileRefs.length > 0) base.fileRefs = fileRefs;
    return base;
  });
}
```

### buildRemoteTools() — pass media through

```ts
private buildRemoteTools(worker: WorkerRegistration, workerId: string): ToolSet {
  const tools: ToolSet = {};
  for (const toolInfo of worker.tools) {
    tools[toolInfo.name] = tool({
      description: toolInfo.description,
      inputSchema: jsonSchema(toolInfo.inputSchema as any),
      execute: async (args: unknown) => {
        const toolCallId = `tc_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        const { result, error, media } = await this.toolDispatch.dispatch(workerId, {
          toolCallId, toolName: toolInfo.name,
          args: (args ?? {}) as Record<string, unknown>,
        });
        if (error) throw new Error(error);
        if (media?.length) return { result, media };
        return result;
      },
    });
  }
  return tools;
}
```

### SessionManager — remove MediaStore

- Remove `mediaStore` from constructor
- Remove media cleanup from `delete()`

### AgentRunner constructor

```ts
constructor(
  private sessionMgr: SessionManager,
  private eventBus: EventBus,
  private connectionRegistry: ConnectionRegistry,
  private toolDispatch: ToolDispatch,
  private defaultLlm: { provider: string; model: string },
  private inlineMediaCache: InlineMediaCache,  // replaces MediaStore
) {}
```

### System prompt addition

```ts
const mediaHint = [
  "Users can attach files to messages. Attached files are saved in .molf/uploads/ within your working directory.",
  "Images are shown to you inline. Non-image files (PDFs, documents, audio) appear as text references.",
  "To view non-image file contents, use the read_file tool with the file path.",
  "The read_file tool can read binary files (images, PDFs, audio) and show you their contents.",
  "Uploaded files persist in the workspace and can be used by shell commands, scripts, and other tools.",
  "Video files cannot be viewed inline — use shell_exec with ffmpeg or similar tools.",
].join(" ");
```

### Tests (Phase 3)

- `InlineMediaCache`: save/load, TTL expiry, maxBytes eviction, totalBytes tracking, `close()`
- `UploadDispatch`: dispatch/resolve, timeout, worker disconnect
- `agent.upload` mutation: validates size, forwards to worker, caches images, returns path
- `agent.upload`: session not found, worker not connected, timeout
- `agent.upload`: non-image NOT cached
- `resolveSessionMessages`: image + cache hit → inline, cache miss → fileRef, non-image → fileRef
- `buildRemoteTools`: passes `media` alongside `result`
- `ToolDispatch`: passes media through `resolveToolCall`
- System prompt includes media hint

---

## Phase 4: Agent-Core + Client-Telegram

**Files:** `packages/agent-core/src/types.ts`, `packages/agent-core/src/session.ts`, `packages/agent-core/src/agent.ts`, `packages/client-telegram/src/handler.ts`, `packages/client-telegram/src/connection.ts`

### Agent-Core type updates

```ts
// types.ts — import FileRef from protocol, do NOT redefine
import type { FileRef } from "@molf-ai/protocol";
export type { FileRef };

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: ResolvedAttachment[];   // inlined image bytes (user AND tool messages)
  fileRefs?: FileRef[];                  // non-inlined file references (user messages)
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
}
```

Two media fields only: `attachments` (resolved bytes for inline) and `fileRefs` (text references).

### toModelMessages() — user messages

```ts
if (msg.role === "user") {
  if (!msg.attachments?.length && !msg.fileRefs?.length) {
    return { role: "user", content: msg.content };
  }

  const parts: Array<TextPart | ImagePart> = [];

  for (const ref of msg.fileRefs ?? []) {
    const sizeMB = ref.size ? ` (${(ref.size / (1024*1024)).toFixed(1)}MB)` : "";
    parts.push({ type: "text", text: `[Attached file: ${ref.path}${sizeMB}, ${ref.mimeType}. Use read_file to access.]` });
  }

  if (msg.content) parts.push({ type: "text", text: msg.content });

  for (const att of msg.attachments ?? []) {
    parts.push({ type: "image", image: att.data, mediaType: att.mimeType });
  }

  return { role: "user", content: parts };
}
```

### toModelMessages() — tool messages with media

```ts
if (msg.role === "tool" && msg.attachments?.length) {
  const content = [{ type: "text", text: msg.content }];
  for (const att of msg.attachments) {
    if (att.mimeType.startsWith("image/")) {
      content.push({ type: "image", data: att.data, mimeType: att.mimeType });
    }
  }
  return { role: "tool", content: [{ type: "tool-result", toolCallId: msg.toolCallId!, toolName: msg.toolName ?? "unknown", result: content }] };
}
```

**TODO**: Verify `result` vs `output` field name against AI SDK `ToolResultPart` type.

### Agent loop — store media on tool messages

```ts
case "tool-result": {
  stepToolResults.push({
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    result: part.output,
    media: part.media,
  });
  break;
}

// When storing:
for (const tr of stepToolResults) {
  const toolAttachments = tr.media?.map(m => ({
    data: new Uint8Array(Buffer.from(m.data, "base64")),
    mimeType: m.mimeType,
  }));

  const toolMsg = this.session.addMessage({
    role: "tool",
    content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
    toolCallId: tr.toolCallId,
    toolName: tr.toolName,
    ...(toolAttachments?.length ? { attachments: toolAttachments } : {}),
  });
}
```

**Note**: Tool result images (`attachments` with `Uint8Array`) won't survive JSON serialization. On session resume they're lost. Accepted degradation — file is still on worker, agent can `read_file` again.

### Client-Telegram — upload via tRPC

`ServerConnection` is a plain object. Add `uploadFile` as a method that calls the tRPC mutation:

```ts
export interface ServerConnection {
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
  wsClient: ReturnType<typeof createWSClient>;
  close: () => void;
}

// uploadFile is just a thin wrapper around the tRPC mutation:
// In handler.ts, call directly:
const uploadResult = await connection.trpc.agent.upload.mutate({
  sessionId,
  data: Buffer.from(media.buffer).toString("base64"),
  filename: media.filename,
  mimeType: media.mimeType,
});
```

No `uploadFile` helper needed — the tRPC client already provides the typed method.

### handler.ts — upload-first flow

```ts
async handleMedia(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    const media = await downloadTelegramMedia(ctx, this.deps.botToken);

    await this.sendAckReaction(ctx);
    await ctx.api.sendChatAction(chatId, "typing");

    const sessionId = await this.deps.sessionMap.getOrCreate(chatId);
    this.deps.renderer.startSession(chatId, sessionId);

    // Upload via tRPC
    const { path, mimeType } = await this.deps.connection.trpc.agent.upload.mutate({
      sessionId,
      data: Buffer.from(media.buffer).toString("base64"),
      filename: media.filename,
      mimeType: media.mimeType,
    });

    // Prompt with file reference
    await this.deps.connection.trpc.agent.prompt.mutate({
      sessionId,
      text: ctx.message?.caption ?? ctx.message?.sticker?.emoji ?? "",
      fileRefs: [{ path, mimeType }],
    });
  } catch (err) {
    // ... error handling ...
  }
}
```

`flushMediaGroup()`: upload each item via `agent.upload`, collect fileRefs, send single prompt.

### Tests (Phase 4)

- `toModelMessages()` user message with fileRefs → TextPart references
- `toModelMessages()` user message with inlined images + fileRefs → correct ordering
- `toModelMessages()` user message with neither → plain string
- `toModelMessages()` tool message with attachments → multimodal ToolResultPart
- Agent loop: stores media as `attachments` on tool messages
- `FileRef` imported from protocol (not redefined)
- Telegram handler: upload → prompt with fileRef
- Media group: multiple uploads → single prompt
- Upload failure: error reply to user

---

## Phase 5: Cleanup — Remove Old MediaStore & Update Tests

**Files to delete:**
- `packages/server/src/media-store.ts`

**Files to update:**
- `packages/server/src/server.ts` — remove `MediaStore` import/instantiation
- `packages/server/src/session-mgr.ts` — remove `MediaStore` dependency
- `packages/protocol/src/types.ts` — remove `MediaRef`, `Attachment`
- `packages/protocol/src/schemas.ts` — remove `mediaRefSchema`, `attachmentSchema`

**Tests to rewrite:**
- `packages/e2e/tests/integration/multimodal.test.ts` — **near-complete rewrite** (~1230 lines). Every test uses the old `attachments: [{ data: base64 }]` → `MediaRef { mediaId }` flow.
- `packages/e2e/helpers/test-server.ts` — expose `uploadDispatch` and `inlineMediaCache` in test context
- All unit tests referencing `MediaStore`, `MediaRef`, `Attachment`

---

## Implementation Order

```
Phase 1 (protocol: FileRef, schemas, helpers — delete old types)
    ↓
Phase 2 (worker: file storage, read_file binary, upload subscription)
    ↓
Phase 3 (server: InlineMediaCache, UploadDispatch, agent.upload mutation, AgentRunner, ToolDispatch, router, system prompt)
    ↓
Phase 4 (agent-core: toModelMessages + agent loop — telegram client: upload-first flow)
    ↓
Phase 5 (cleanup: delete MediaStore, rewrite multimodal.test.ts)
```

Each phase includes its own tests. Run `bun run test` after each phase.

**Highest risk**: Phase 5 — `multimodal.test.ts` rewrite is ~1230 lines.

## Key Files Summary

| Package | File | Change |
|---------|------|--------|
| protocol | `src/types.ts` | Replace `MediaRef`/`Attachment` with `FileRef`. Add upload types. |
| protocol | `src/schemas.ts` | Replace schemas. Add `agentUploadInput`, `media` on `workerToolResultInput`, upload dispatch schemas. `MAX_ATTACHMENT_BYTES` → 15MB. |
| protocol | `src/helpers.ts` | Update `lastMessagePreview` for `FileRef`. |
| agent-core | `src/types.ts` | Import `FileRef` from protocol. Two fields: `attachments` + `fileRefs`. |
| agent-core | `src/session.ts` | `toModelMessages()` handles fileRefs + attachments for user and tool messages. |
| agent-core | `src/agent.ts` | Agent loop stores `media` as `attachments` on tool messages. |
| agent-core | `src/tools/read-file.ts` | Binary detection (images, PDFs, audio — no video). 15MB size guard. Return `{ result, media }`. |
| worker | `src/uploads.ts` | **New.** `saveUploadedFile()` with filename sanitization + path traversal check. |
| worker | `src/tool-executor.ts` | Extract `media` from `{ result, media }` returns. |
| worker | `src/connection.ts` | Pass `media` in `toolResult`. Add `onUpload` subscription. |
| server | `src/inline-media-cache.ts` | **New.** Bounded TTL cache (200MB, LRU, periodic prune). |
| server | `src/upload-dispatch.ts` | **New.** Dedicated upload dispatch (mirrors ToolDispatch). |
| server | `src/server.ts` | Replace MediaStore with InlineMediaCache + UploadDispatch. No architecture change. |
| server | `src/agent-runner.ts` | FileRef handling. Runtime inlining. System prompt. |
| server | `src/tool-dispatch.ts` | Pass `media` through resolver. |
| server | `src/router.ts` | Add `agent.upload`, `worker.onUpload`, `worker.uploadResult`. Pass `fileRefs` and `media`. |
| server | `src/session-mgr.ts` | Remove MediaStore dependency. |
| server | `src/media-store.ts` | **Delete.** |
| client-telegram | `src/handler.ts` | Upload via `agent.upload` mutation, then prompt with fileRefs. |
| e2e | `tests/integration/multimodal.test.ts` | **Near-complete rewrite.** |

## What This Plan Intentionally Omits

| Omission | Rationale |
|----------|-----------|
| TUI client uploads | Telegram only. TUI is a separate feature. |
| Disk-backed image cache | In-memory + 200MB cap is sufficient. |
| Auto-cleanup of uploads | Shared directory, manual cleanup. |
| Video in read_file | No LLM can process video. Use `shell_exec` + ffmpeg. |
| Per-session upload directories | Shared `.molf/uploads/`. Per-session isolation later if needed. |
| Tool media persistence on resume | Ephemeral. File still on worker, agent can `read_file` again. |
| Upload rate limiting | Add if abuse is observed. |
| MIME type validation | Client-provided mimeType trusted. Magic bytes later if needed. |
| Parallel media group uploads | Sequential for now. |
