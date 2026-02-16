# Multimodal Content Support Plan

## Goal

Enable users to send images, documents, audio, and stickers to the LLM through any client. The LLM responds with text (as today). Media flows through the existing tRPC WebSocket path with minimal new infrastructure.

## Current State

Every message flows as a plain `string`:

```
SessionMessage.content: string
agentPromptInput = { sessionId, text }
Agent.prompt(text: string)
Session.toModelMessages() → { role: "user", content: string }
```

No media handling anywhere in the stack. Two separate `SessionMessage` types exist (protocol and agent-core) that are nearly identical but independent.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Content model | **`content: string` unchanged. New `attachments?` field.** | Zero breakage. Every consumer of `content` keeps working. Only media-aware code touches `attachments`. Avoids pervasive `typeof content === "string"` checks. |
| Media transfer | Base64 in `agentPromptInput.attachments` | One atomic tRPC mutation. No HTTP server, no multipart, no separate auth. Base64 overhead (~33%) is acceptable for LLM-relevant file sizes. |
| Media persistence | Files on disk at `data/media/{mediaId}.{ext}` | Session JSON stays compact (stores `mediaId` refs, not blobs). Avoids bloating `SessionManager.list()` which reads every session file. |
| Type naming | `Attachment` (wire), `MediaRef` (storage), `ResolvedAttachment` (runtime) | Three distinct types for three layers. No collision with AI SDK's own `FilePart`/`ImagePart` exports. |
| Agent.prompt() | `prompt(text: string, attachments?: ResolvedAttachment[])` | Additive signature. Existing callers unchanged. Text stays first-class parameter. |
| Agent lifecycle | Keep current per-prompt Agent creation | No changes. Re-reading media from local disk per prompt is trivial. |
| WS maxPayload | Set explicitly to 50MB | Defensive. A 20MB doc base64-encoded is ~27MB. Currently unset (defaults to 100MB). |
| Telegram media groups | Deferred to v2 | Single-media messages cover 90%+ of use cases. Buffering adds significant complexity. |
| Image optimization | Deferred to v2 | Resize/compress before LLM (Moltis-style progressive JPEG) is important but not blocking for v1. Add size validation now; optimization later. |

## Type Architecture

Three layers, three attachment types. Clean separation of wire, storage, and runtime concerns:

```
Client (Telegram/TUI)          Server (AgentRunner)           Agent-Core (Session/LLM)
─────────────────────          ─────────────────────          ──────────────────────────
Attachment                     MediaRef                       ResolvedAttachment
{ data: string (base64),  →   { mediaId: string,        →   { data: Uint8Array,
  mimeType: string,            mimeType: string,              mimeType: string,
  filename?: string }          filename?: string }            filename?: string }
                          save to disk               load from disk
```

- **`Attachment`** — sent by clients in `agentPromptInput.attachments`. Carries base64 data.
- **`MediaRef`** — stored in `SessionMessage.attachments` on disk. Compact `mediaId` reference.
- **`ResolvedAttachment`** — used by agent-core Session/Agent. Holds actual bytes for the LLM.

## Phase 1: Protocol — Attachment Types and Schemas

**Files:** `packages/protocol/src/schemas.ts`, `packages/protocol/src/types.ts`, `packages/protocol/src/index.ts`

### New types in `types.ts`

```ts
/** Stored in SessionMessage on disk — references media by ID */
interface MediaRef {
  mediaId: string;
  mimeType: string;
  filename?: string;
}

/** Sent by clients in agentPromptInput — carries base64 data */
interface Attachment {
  data: string;       // base64-encoded
  mimeType: string;
  filename?: string;
}
```

### SessionMessage — add optional `attachments`

```ts
interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;                    // ← UNCHANGED, stays string
  attachments?: MediaRef[];           // ← NEW, only on user messages with media
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
}
```

`content` remains `string` everywhere. No existing consumer breaks.

### Schema changes in `schemas.ts`

```ts
const mediaRefSchema = z.object({
  mediaId: z.string(),
  mimeType: z.string(),
  filename: z.string().optional(),
});

const attachmentSchema = z.object({
  data: z.string(),        // base64 — keep Zod validation minimal (no .max() on data)
  mimeType: z.string(),
  filename: z.string().optional(),
});
```

- Add `attachments: z.array(mediaRefSchema).optional()` to `sessionMessageSchema`
- Add `attachments: z.array(attachmentSchema).optional()` to `agentPromptInput`

### Helpers

- `lastMessagePreview(msg: SessionMessage): string` — if `msg.attachments?.length`, return description based on first attachment's mimeType (`[image]`, `[document]`, `[audio]`, etc.), prepended to content if non-empty. If no attachments, return `msg.content` as today. Used by `SessionManager.list()`.
- Size constants: `MAX_IMAGE_BYTES = 10 * 1024 * 1024` (10MB), `MAX_DOCUMENT_BYTES = 10 * 1024 * 1024`, `MAX_AUDIO_BYTES = 10 * 1024 * 1024`
- `getMaxBytes(mimeType: string): number` — returns the appropriate limit for a given MIME type.

**`index.ts`:** Export all new types, schemas, and helpers.

### Tests (Phase 1)

- Zod schema validation: `mediaRefSchema`, `attachmentSchema`
- `sessionMessageSchema` parses with and without `attachments`
- `agentPromptInput` parses with and without `attachments`
- `lastMessagePreview()`: text-only message, image attachment, document attachment, mixed
- `getMaxBytes()`: returns correct limits for `image/*`, `application/pdf`, `audio/*`, unknown types

## Phase 2: Agent-Core — Multimodal Prompt Support

**Files:** `packages/agent-core/src/types.ts`, `packages/agent-core/src/session.ts`, `packages/agent-core/src/agent.ts`

### New type in `types.ts`

```ts
/** Resolved attachment with actual bytes — used for LLM calls */
interface ResolvedAttachment {
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}
```

Update agent-core's `SessionMessage` to add optional `attachments`:

```ts
interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;                          // ← stays string
  attachments?: ResolvedAttachment[];       // ← NEW, holds bytes for LLM
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
}
```

### Session.toModelMessages()

Update the user message branch (`session.ts:46-48`). Import `ImagePart` and `FilePart` (aliased to avoid collision with our own types) from `ai`:

```ts
import type { ModelMessage, ToolCallPart, TextPart, ImagePart, FilePart as AISdkFilePart } from "ai";
```

```ts
if (msg.role === "user") {
  if (!msg.attachments?.length) {
    return { role: "user", content: msg.content };  // existing behavior, unchanged
  }
  // Build multimodal content array for AI SDK
  const parts: Array<TextPart | ImagePart | AISdkFilePart> = [];
  if (msg.content) {
    parts.push({ type: "text", text: msg.content });
  }
  for (const att of msg.attachments) {
    if (att.mimeType.startsWith("image/")) {
      // AI SDK ImagePart: field is `image` (not `data`), mediaType optional
      parts.push({ type: "image", image: att.data, mediaType: att.mimeType });
    } else {
      // AI SDK FilePart: field is `data`, mediaType REQUIRED
      parts.push({ type: "file", data: att.data, mediaType: att.mimeType });
    }
  }
  return { role: "user", content: parts };
}
```

**Important:** AI SDK `ImagePart` uses `{ type: "image", image: data }` while `FilePart` uses `{ type: "file", data: data }`. The field names differ. Both accept `Uint8Array` directly via `DataContent`. This mapping is an implementation detail inside `toModelMessages()`.

Assistant and tool message branches remain unchanged — they only produce `string` content.

### Agent.prompt()

Change signature from `prompt(text: string)` to `prompt(text: string, attachments?: ResolvedAttachment[])`:

```ts
async prompt(text: string, attachments?: ResolvedAttachment[]): Promise<SessionMessage> {
  if (this.status === "streaming" || this.status === "executing_tool") {
    throw new Error("Agent is busy. Abort or wait for current operation.");
  }

  this.session.addMessage({
    role: "user",
    content: text,
    ...(attachments?.length ? { attachments } : {}),
  });
  // ... rest of LLM loop unchanged ...
}
```

Existing callers passing just `text` continue to work with no changes.

### Session.serialize() caveat

`Session.serialize()` does a shallow spread of each message (`{ ...m }`). If a message has `attachments` with `Uint8Array` data, the serialized output includes binary references that won't survive `JSON.stringify`. This is acceptable because:
- `Session.serialize()` is not used for disk persistence (AgentRunner uses `SessionManager` directly)
- It's only used in tests for round-trip validation
- Tests that involve attachments should use `Session.deserialize()` with pre-built messages, not `serialize()` round-trips

### Tests (Phase 2)

- `toModelMessages()` with text-only user message: returns `{ role: "user", content: string }` (unchanged)
- `toModelMessages()` with attachments: returns correct AI SDK content array
  - Image attachment → `ImagePart` with `type: "image"` and `image` field
  - PDF attachment → `FilePart` with `type: "file"` and `data` field
  - Empty content + image → content array with only ImagePart (no TextPart)
- `Agent.prompt(text)` works without attachments (backward compat)
- `Agent.prompt(text, attachments)` works with attachments
- Assistant/tool messages in `toModelMessages()` unchanged by the feature

## Phase 3: Server — Media Store and Prompt Flow

**Files:** new `packages/server/src/media-store.ts`, modify `packages/server/src/agent-runner.ts`, `packages/server/src/router.ts`, `packages/server/src/server.ts`, `packages/server/src/session-mgr.ts`

### MediaStore (new file)

Simple file-based storage in `data/media/`:

```ts
class MediaStore {
  constructor(dataDir: string)  // creates data/media/ dir lazily
  save(buffer: Uint8Array, mimeType: string, filename?: string): { mediaId: string }
  load(mediaId: string): { buffer: Uint8Array; mimeType: string } | null
  delete(mediaId: string): void
  deleteMany(mediaIds: string[]): void
}
```

- `mediaId` format: `{uuid}.{ext}` where ext is derived from mimeType via a simple mapping (`image/jpeg` → `jpg`, `application/pdf` → `pdf`, etc.)
- Files stored as raw binary (not base64)
- `data/media/` directory created on first `save()` call

### AgentRunner changes

Update `prompt()` signature at `agent-runner.ts:135`:

```ts
async prompt(
  sessionId: string,
  text: string,
  attachments?: Attachment[],  // from protocol — has base64 data
): Promise<{ messageId: string }>
```

The flow inside `prompt()`:

1. **Load session** (unchanged): `sessionMgr.load(sessionId)`
2. **Check busy/worker** (unchanged)
3. **Process attachments** (new, if present):
   - For each `Attachment`: decode base64 → `Uint8Array`, validate size against `getMaxBytes(mimeType)`, save to MediaStore → get `mediaId`
   - Build `MediaRef[]` for persistence
4. **Persist user message**: `sessionMgr.addMessage(sessionId, { content: text, attachments: mediaRefs, ... })`
5. **Deserialize session for Agent with resolved media** (updated):
   ```ts
   // Resolve ALL historical messages (not just current)
   const resolvedMessages = await this.resolveSessionMessages(sessionFile.messages);
   const session = Session.deserialize({ messages: resolvedMessages });
   ```
6. **Create Agent** (unchanged): `new Agent(config, session)`
7. **Register tools** (unchanged)
8. **Run prompt**: `this.runPrompt(activeSession, text, resolvedCurrentAttachments)`

The key new method:

```ts
private async resolveSessionMessages(
  messages: ProtocolSessionMessage[]
): Promise<AgentCoreSessionMessage[]> {
  return Promise.all(messages.map(async (msg) => {
    if (!msg.attachments?.length) {
      return msg;  // pass through as-is
    }
    // Resolve MediaRef[] → ResolvedAttachment[]
    const resolved = await Promise.all(msg.attachments.map(async (ref) => {
      const media = this.mediaStore.load(ref.mediaId);
      if (!media) {
        console.warn(`Media not found: ${ref.mediaId}, skipping`);
        return null;
      }
      return { data: media.buffer, mimeType: ref.mimeType, filename: ref.filename };
    }));
    return {
      ...msg,
      attachments: resolved.filter(Boolean),
    };
  }));
}
```

Update `runPrompt()` to pass attachments to `agent.prompt()`:

```ts
private async runPrompt(
  activeSession: ActiveSession,
  text: string,
  attachments?: ResolvedAttachment[],
): Promise<void> {
  try {
    await activeSession.agent.prompt(text, attachments);
    // ... persist assistant/tool messages (unchanged) ...
  }
  // ... error handling and cleanup unchanged ...
}
```

**Note on `mapAgentEvent` (line 324-367):** For v1, assistant messages never have attachments. The `turn_complete` event's `message.content` stays `string`. No change needed to `mapAgentEvent`. If tools produce media in the future, this boundary will need updating.

### Router changes

Pass `attachments` through to AgentRunner (`router.ts:128`):

```ts
return await ctx.agentRunner.prompt(input.sessionId, input.text, input.attachments);
```

### Server.ts changes

- Create `MediaStore` instance alongside other services:
  ```ts
  const mediaStore = new MediaStore(config.dataDir);
  ```
- Pass it to `AgentRunner` constructor (add to constructor params)
- Set explicit `maxPayload` on WebSocketServer:
  ```ts
  const wss = new WebSocketServer({
    host: config.host,
    port: config.port,
    maxPayload: 50 * 1024 * 1024,  // 50MB
  });
  ```

### SessionManager changes

- `list()` at line 77: Use `lastMessagePreview(lastMsg)` instead of raw `lastMsg.content`
- `delete()`: Scan deleted session's messages for `attachments` field and call `mediaStore.deleteMany(allMediaIds)`. This requires SessionManager to have a reference to MediaStore (pass via constructor or method param).

### Tests (Phase 3)

- **MediaStore:** save/load/delete cycle, load missing file returns null, deleteMany cleans up, mediaId format includes correct extension
- **AgentRunner:**
  - Prompt with base64 attachment: decode → save to MediaStore → persist MediaRef in session
  - Prompt without attachments: unchanged behavior
  - `resolveSessionMessages()`: resolves MediaRef → ResolvedAttachment, skips missing media
  - Size validation: reject attachments exceeding `getMaxBytes()`
- **Integration:** Prompt with attachment via tRPC, verify LLM receives correct AI SDK content parts (mocked LLM via `mockStreamText`)

## Phase 4: Client-Telegram — Media Messages

**Files:** new `packages/client-telegram/src/media.ts`, modify `packages/client-telegram/src/handler.ts`, `packages/client-telegram/src/index.ts`

### media.ts (new file)

Helpers for downloading Telegram media:

```ts
interface DownloadedMedia {
  buffer: Uint8Array;
  mimeType: string;
  filename: string;
}

async function downloadTelegramMedia(ctx: Context, botToken: string): Promise<DownloadedMedia>
```

- Detect media type from context: `ctx.message.photo`, `.document`, `.audio`, `.voice`, `.video`, `.video_note`, `.sticker`
- Photos: pick largest resolution (`photo[photo.length - 1]`), mimeType is `image/jpeg`
- Get file info via `ctx.api.getFile(fileId)` → construct download URL `https://api.telegram.org/file/bot${botToken}/${file.file_path}` → fetch bytes
- mimeType from Telegram metadata (`.document.mime_type`) or inferred (photos = `image/jpeg`, stickers = `image/webp`)
- Pre-download size check using Telegram's `file_size` metadata against `getMaxBytes()`

**Note:** The bot token is needed to construct the download URL. Add `botToken` to `HandlerDeps` interface so the media helper can access it.

### handler.ts changes

Add `handleMedia(ctx: Context)` method to `MessageHandler`:

```ts
async handleMedia(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    // 1. Pre-download size validation
    const fileSize = getFileSize(ctx.message);
    const mimeType = detectMimeType(ctx.message);
    if (fileSize && fileSize > getMaxBytes(mimeType)) {
      await ctx.reply(`File too large. Maximum for this type is ${formatBytes(getMaxBytes(mimeType))}.`);
      return;
    }

    // 2. Download media from Telegram
    const media = await downloadTelegramMedia(ctx, this.deps.botToken);

    // 3. Convert buffer to base64
    const base64 = Buffer.from(media.buffer).toString("base64");

    // 4. Ack reaction + typing indicator
    await this.sendAckReaction(ctx);
    await ctx.api.sendChatAction(chatId, "typing");

    // 5. Resolve session
    const sessionId = await this.deps.sessionMap.getOrCreate(chatId);

    // 6. Start renderer
    this.deps.renderer.startSession(chatId, sessionId);

    // 7. Submit prompt with attachment
    await this.deps.connection.trpc.agent.prompt.mutate({
      sessionId,
      text: ctx.message.caption ?? ctx.message.sticker?.emoji ?? "",
      attachments: [{ data: base64, mimeType: media.mimeType, filename: media.filename }],
    });
  } catch (err) {
    console.error("[telegram] Error processing media:", err);
    try {
      await ctx.reply("Something went wrong processing your media. Try again or send text instead.");
    } catch { /* ignore reply failure */ }
  }
}
```

### index.ts changes

Register media handlers alongside existing text handler:

```ts
// Media handlers (DMs only)
const mediaFilter = (ctx: Context) => ctx.chat?.type === "private";

bot.on("message:photo", async (ctx) => { if (mediaFilter(ctx)) await handler.handleMedia(ctx); });
bot.on("message:document", async (ctx) => { if (mediaFilter(ctx)) await handler.handleMedia(ctx); });
bot.on("message:audio", async (ctx) => { if (mediaFilter(ctx)) await handler.handleMedia(ctx); });
bot.on("message:voice", async (ctx) => { if (mediaFilter(ctx)) await handler.handleMedia(ctx); });
bot.on("message:video", async (ctx) => { if (mediaFilter(ctx)) await handler.handleMedia(ctx); });
bot.on("message:sticker", async (ctx) => { if (mediaFilter(ctx)) await handler.handleMedia(ctx); });
```

### renderer.ts — NO CHANGES

LLM responses are text-only for v1. `turn_complete` event's `message.content` is always `string`. The renderer handles it the same way as today.

### Tests (Phase 4)

- `downloadTelegramMedia()` with mocked grammY context: photo, document, sticker
- Pre-download size validation rejects oversized files
- `handleMedia()` integration: download + encode + submit prompt with attachment
- Handler replies with error on download failure

## Phase 5: Client-TUI — Minimal Display (Optional for v1)

**Files:** `packages/client-tui/src/types.ts`, `packages/client-tui/src/hooks/use-server.ts`

Minimal changes. TUI sends text only for v1.

### types.ts

Add optional `attachments` metadata to `DisplayMessage`:

```ts
interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;                                              // ← stays string
  attachments?: { mimeType: string; filename?: string }[];     // ← display-only metadata
  toolCalls?: { toolCallId: string; toolName: string; args: Record<string, unknown> }[];
  toolCallId?: string;
  timestamp: number;
}
```

### use-server.ts / MessageItem

- When loading session history, copy `attachments` metadata to DisplayMessage if present
- `MessageItem` component: if `attachments` present, show `[Image: filename]` or `[File: filename]` markers

No TUI media input for v1 — clipboard paste and file path input are separate features.

## Migration & Backward Compatibility

- `SessionMessage.content` stays `string` — **zero breaking changes to any consumer**
- `SessionMessage.attachments` is optional — existing session JSON files parse fine (field absent)
- `agentPromptInput.attachments` is optional — existing clients work unchanged
- `Agent.prompt(text)` still works — `attachments` parameter is optional
- `turn_complete` event's `message.content` stays `string` — no client-side event handling changes
- `data/media/` directory created lazily on first save
- Both protocol and agent-core `SessionMessage` types get `attachments?` with different attachment types (`MediaRef` vs `ResolvedAttachment`) — this matches the existing pattern where these types are separate

## What This Plan Intentionally Omits

| Omission | Rationale |
|----------|-----------|
| HTTP upload endpoint | Base64 in tRPC is sufficient for v1 file sizes. Add HTTP multipart in v2 if needed. |
| Agent lifecycle refactoring | Per-prompt Agent creation with local disk reads is fine. No TTL/eviction. |
| Media group buffering | Telegram album support deferred. Single media messages are the common case. |
| Image optimization | Resizing, HEIC conversion, EXIF stripping, progressive JPEG compression (Moltis-style). Important for production but not blocking v1. Size validation rejects oversized files. |
| TUI media input | Clipboard paste, file path input. Separate feature. |
| Renderer `ContentPart[]` handling | LLM responses are text-only. No media rendering needed in v1. |
| Media retrieval endpoint | No client needs to fetch media bytes from server in v1. |
| Sending media to users | When tools produce media output, add rendering then. |
| SessionMessage type unification | Protocol and agent-core have separate `SessionMessage` types. Both get `attachments` but unifying them is a separate concern. |

## Implementation Order

```
Phase 1 (protocol: MediaRef, Attachment, schema updates, helpers)
    ↓
Phase 2 (agent-core: ResolvedAttachment, toModelMessages, prompt signature)
    ↓
Phase 3 (server: MediaStore, AgentRunner, router, WS maxPayload)
    ↓
Phase 4 (telegram) ←→ Phase 5 (tui)  — independent, can be parallel
```

Each phase includes its own tests. Run `bun run test` after each phase to catch regressions early.

## Key Files to Modify

| Package | File | Change |
|---------|------|--------|
| protocol | `src/types.ts` | Add `MediaRef`, `Attachment` types. Add `attachments?: MediaRef[]` to `SessionMessage`. |
| protocol | `src/schemas.ts` | Add `mediaRefSchema`, `attachmentSchema`. Update `sessionMessageSchema`, `agentPromptInput`. |
| protocol | `src/index.ts` | Export new types, schemas, helpers. |
| agent-core | `src/types.ts` | Add `ResolvedAttachment`. Add `attachments?: ResolvedAttachment[]` to `SessionMessage`. |
| agent-core | `src/session.ts` | Update `toModelMessages()` user branch. Add `ImagePart`/`FilePart` imports from AI SDK. |
| agent-core | `src/agent.ts` | Change `prompt(text)` → `prompt(text, attachments?)`. |
| server | `src/media-store.ts` | **New file.** `MediaStore` class: save/load/delete. |
| server | `src/agent-runner.ts` | Add `attachments` param to `prompt()`. Add `resolveSessionMessages()`. Pass MediaStore. |
| server | `src/router.ts` | Pass `input.attachments` to `agentRunner.prompt()`. |
| server | `src/server.ts` | Create `MediaStore` instance. Set `maxPayload: 50MB` on WS server. |
| server | `src/session-mgr.ts` | Use `lastMessagePreview()` in `list()`. Clean up media on `delete()`. |
| client-telegram | `src/media.ts` | **New file.** `downloadTelegramMedia()` helper. |
| client-telegram | `src/handler.ts` | Add `handleMedia()` method. Add `botToken` to deps. |
| client-telegram | `src/index.ts` | Register `message:photo`, `message:document`, etc. handlers. |
| client-tui | `src/types.ts` | Add optional `attachments` metadata to `DisplayMessage`. |
