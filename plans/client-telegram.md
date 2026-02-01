# Plan: client-telegram package

## Overview

Add a `packages/client-telegram` package that acts as a Telegram bot client for Molf Assistant. It connects to the Molf server via tRPC WebSocket (same as `client-tui`) and bridges Telegram DM conversations to the agent.

**Library:** grammY (same as OpenClaw reference)
**Transport:** Long-polling (getUpdates)
**Accounts:** Single bot token
**Chat types:** DM only
**Access:** Allowlist (configured user IDs/usernames)

---

## Architecture

```
Telegram API
    |  (grammY long-polling)
    v
client-telegram  ──tRPC WebSocket──>  server  ──>  agent-core + worker
    |
    ├── bot.ts           (grammY bot setup, middleware, polling)
    ├── handler.ts       (message handler, routes DM text to server)
    ├── commands.ts      (native commands: /new, /status, /help)
    ├── session-map.ts   (Telegram chatId <-> Molf sessionId mapping)
    ├── renderer.ts      (agent events -> Telegram messages)
    ├── streaming.ts     (edit-in-place draft streaming)
    ├── format.ts        (markdown -> Telegram HTML conversion)
    ├── chunking.ts      (split long messages at 4000 char boundary)
    ├── approval.ts      (tool approval inline keyboards)
    ├── access.ts        (allowlist check middleware)
    ├── config.ts        (load config from molf.yaml + env vars)
    └── index.ts         (entry point, CLI args, connect & start)
```

**Dependency flow:**
```
@molf-ai/protocol
    ^
client-telegram  (grammY, @grammyjs/transformer-throttler, @trpc/client, ws)
```

---

## Features

### F1. Server Connection

- Connect to Molf server via tRPC WebSocket (same pattern as `client-tui`)
- Authenticate with `MOLF_TOKEN`
- CLI args: `--server-url`, `--token`, `--worker-id`
- Env vars: `MOLF_SERVER_URL`, `MOLF_TOKEN`, `MOLF_WORKER_ID`, `TELEGRAM_BOT_TOKEN`
- Auto-discover first available worker if `--worker-id` not provided
- Reconnect on WebSocket disconnect

### F2. Telegram Bot Setup

- Create grammY `Bot` instance with token from config/env
- Apply `apiThrottler()` transformer from `@grammyjs/transformer-throttler` to prevent Telegram rate-limit errors (essential for streaming edits + typing indicators)
- Track `lastUpdateId` to skip already-processed updates on polling reconnect (update deduplication)
- Long-polling mode via `bot.start()`
- Register `bot.catch()` error boundary so unhandled middleware errors don't crash the polling loop
- Graceful shutdown on SIGINT/SIGTERM (stop polling, close WebSocket)
- Middleware chain: access check -> command routing -> message handling

### F3. Access Control (Allowlist)

- Configure allowed users in `molf.yaml` under `telegram.allowedUsers`
- Also via env var `TELEGRAM_ALLOWED_USERS` (comma-separated)
- Accept both numeric Telegram user IDs and @usernames
- grammY middleware that rejects messages from non-allowed users silently (or with a brief "unauthorized" reply, configurable)

### F4. Session Management

- Each Telegram user (by chat ID) maps to one Molf session
- Session mapping persisted in memory (Map<chatId, sessionId>)
- On first message from a user: auto-create session via `trpc.session.create`
- `/new` command: create a fresh session, update the mapping
- `/clear` is an alias for `/new` (both create a new session)
- No auto-reset; sessions persist until user explicitly runs /new

### F5. Message Handling (Inbound)

- Listen for text messages in DMs only (ignore groups, channels, non-text)
- **Text fragment buffering:** Telegram splits long user pastes (~4096 chars) into multiple inbound messages. Buffer near-limit messages and append subsequent parts before processing (max 12 parts, 1.5s timeout between parts, 50KB total cap). This prevents a pasted code block from being processed as multiple separate prompts.
- On text message received (after buffering resolves):
  1. Check allowlist
  2. React with acknowledgment emoji (e.g. eyes) to confirm receipt
  3. Resolve or create session for this chat
  4. Send typing action (`sendChatAction("typing")`)
  5. Submit to agent via `trpc.agent.prompt.mutate({ sessionId, text })`
  6. Subscribe to `trpc.agent.onEvents` for this session

### F6. Response Rendering (Outbound)

- Subscribe to agent events for active sessions
- Handle each event type:

| Event | Behavior |
|-------|----------|
| `status_change` | Update internal state, manage typing indicator |
| `content_delta` | Accumulate text, update draft message (edit-in-place) |
| `tool_call_start` | Send status message: "Running: {toolName}..." |
| `tool_call_end` | Update status message with completion |
| `turn_complete` | Send final message (replace draft), remove typing |
| `error` | Send friendly error message |
| `tool_approval_required` | Send inline keyboard (Approve/Deny) |

### F7. Edit-in-Place Streaming

- On first `content_delta`: send a new message, store message ID
- On subsequent deltas: edit the message with accumulated content
- Throttle edits (300ms minimum interval) to respect Telegram rate limits
- On `turn_complete`: do a final edit with the complete content
- If content exceeds 4000 chars during streaming: stop editing current message, start a new one for overflow
- Convert markdown to Telegram HTML before each edit
- On HTML parse error: fallback to plain text

### F8. Message Formatting

- Convert agent markdown to Telegram HTML subset:
  - `**bold**` -> `<b>bold</b>`
  - `*italic*` -> `<i>italic</i>`
  - `` `code` `` -> `<code>code</code>`
  - ` ```lang\nblock\n``` ` -> `<pre><code class="language-lang">block</code></pre>`
  - `[text](url)` -> `<a href="url">text</a>`
  - `~~strike~~` -> `<s>strike</s>`
- On parse error from Telegram API: retry with plain text (strip all HTML)

### F9. Long Message Chunking

- Effective limit: 4000 characters per message (safety margin below Telegram's 4096 wire limit, accounts for HTML entity expansion like `&` -> `&amp;`)
- When final response exceeds limit, split into multiple messages
- **Markdown-aware splitting:** never split inside a fenced code block (``` ... ```). If a code block straddles the boundary, break before the opening fence or after the closing fence.
- Split at logical boundaries (in priority order):
  1. Code fence boundary (never split inside)
  2. Double newline (paragraph break)
  3. Single newline
  4. Sentence end (`. `)
  5. Hard cut at 4000 as last resort
- Send chunks sequentially with brief delay between them
- First chunk replaces the streaming draft message; subsequent chunks are new messages

### F10. Tool Call Status Display

- On `tool_call_start`: send or edit a status message showing tool name
  - Format: "Running: `{toolName}`..."
- On `tool_call_end`: update status with result indicator
  - Success: "Completed: `{toolName}`"
  - Error: "Failed: `{toolName}`"
- When agent response follows, the status message stays (not deleted)
- Multiple concurrent tool calls: update the same status message with all active tools

### F11. Tool Approval via Inline Buttons

- On `tool_approval_required` event:
  - Send message: "Tool call requires approval: `{toolName}`\nArguments: {summary}"
  - Attach inline keyboard: [ Approve ] [ Deny ]
- On button callback:
  - Call `trpc.tool.approve` or `trpc.tool.deny`
  - Edit the approval message to show the decision (e.g., "Approved: {toolName}")
  - Call `answerCallbackQuery(callback.id)` immediately on any button press to dismiss Telegram's loading spinner and prevent timeout retries
  - Then process the approve/deny logic
- Timeout: if no response within configurable period, could auto-deny (future enhancement)

### F12. Typing Indicator

- Send `sendChatAction("typing")` when agent starts processing
- Repeat every 5 seconds while agent is active (Telegram typing expires after ~5s)
- Stop on `turn_complete` or `error`
- Use `setInterval` with cleanup

### F13. Acknowledgment Reaction

- When a message is received and passes allowlist:
  - React with an emoji (configurable, default: eyes reaction)
- Lets user know the bot received and is processing their message
- Remove or replace reaction when response starts streaming (optional, future)

### F14. Native Commands

**`/new`** (alias: `/clear`)
- Create a new Molf session for this chat
- Reply: "New session started."

**`/status`**
- Show: connection status (server connected?), agent status (idle/streaming/executing), current session info, worker info
- Reply with formatted status block

**`/help`**
- List available commands with descriptions
- If command list exceeds a single message, paginate with inline keyboard buttons ([ < Prev ] [ Next > ])
- Button callback data format: `help_page_{page}`
- On button press: edit the message to show the requested page
- Reply with command list

### F15. Configuration

**In `molf.yaml`:**
```yaml
telegram:
  botToken: "123:ABC..."        # or use env var
  allowedUsers:                  # Telegram user IDs or @usernames
    - "123456789"
    - "@username"
  ackReaction: "eyes"            # emoji for acknowledgment
  streamingThrottleMs: 300       # min interval between message edits
```

**Environment variables (override yaml):**
- `TELEGRAM_BOT_TOKEN` — bot token (required)
- `TELEGRAM_ALLOWED_USERS` — comma-separated user IDs/usernames
- `MOLF_SERVER_URL` — server WebSocket URL
- `MOLF_TOKEN` — server auth token
- `MOLF_WORKER_ID` — preferred worker ID

**Priority:** env vars override yaml values.

### F16. Graceful Shutdown

- On SIGINT/SIGTERM:
  1. Stop grammY polling
  2. Close all active event subscriptions
  3. Close tRPC WebSocket connection
  4. Exit process

### F17. Error Handling

- **`bot.catch()` error boundary:** Register a bot-wide catch handler so unhandled errors in any middleware/handler don't crash the polling loop. Log the error and continue processing.
- Telegram API errors: log, send friendly message to user if possible
- Server connection lost: log, attempt reconnect, queue messages or notify user
- Agent errors: forward as friendly message ("Something went wrong. Try /new to start fresh.")
- Never expose stack traces or internal details to Telegram users

---

## Package Setup

- Add `packages/client-telegram/` to workspace
- `package.json` with dependencies: `grammy`, `@grammyjs/transformer-throttler`, `@trpc/client`, `ws`, `@molf-ai/protocol`
- `tsconfig.json` extending root config
- Add `dev:client-telegram` script to root `package.json`
- Entry: `bun run packages/client-telegram/src/index.ts -- --token <TOKEN>`

---

## Implementation Order

1. Package scaffolding (package.json, tsconfig, entry point)
2. Config loading (yaml + env vars)
3. Server connection (tRPC WebSocket client, reuse pattern from client-tui)
4. Bot setup (grammY, throttler, update dedup, bot.catch(), polling, graceful shutdown)
5. Access control middleware (allowlist)
6. Native commands (/new, /clear, /status, /help with pagination)
7. Session mapping (chatId -> sessionId, auto-create)
8. Inbound message handler (text -> agent prompt, with fragment buffering)
9. Event subscription and basic response rendering (turn_complete -> send message)
10. Markdown to Telegram HTML formatting
11. Long message chunking (markdown-aware, 4000 char limit)
12. Edit-in-place streaming
13. Typing indicator
14. Acknowledgment reaction
15. Tool call status display
16. Tool approval inline buttons
17. Error handling polish
18. Tests (alongside each module, not as a separate final step)

---

## Reference

The OpenClaw project (`refs/openclaw/src/telegram/`) uses grammY with a similar architecture and has ~47 test files covering Telegram bot functionality. Use it as a reference for:

- grammY mocking patterns (full module mock with API spy stubs)
- Markdown-to-Telegram-HTML conversion logic and edge cases
- Draft chunking / streaming implementation
- Inline button callback handling
- Message context building and handler extraction from spies

Adapt patterns to Bun test runner conventions (see project CLAUDE.md for `mock.module` setup requirements).

---

## Testing

Tests live in `packages/client-telegram/tests/`, mirroring the `src/` module structure. Every module gets a corresponding test file written alongside implementation (not as a separate final step).

**Pure-logic modules** (format, chunking, session-map, access, config) — straightforward unit tests with no mocking needed beyond env var isolation.

**grammY-dependent modules** (bot, handler, commands, streaming, renderer, approval, typing) — mock the entire `grammy` module via `mock.module()` before imports (per project convention). Provide a stub `Bot` class with spy functions for all used API methods (`sendMessage`, `editMessageText`, `sendChatAction`, `setMessageReaction`, `answerCallbackQuery`). Extract registered handlers from spy call args to invoke them directly with fake context objects.

**tRPC-dependent modules** — mock the connection module with stub `mutate`/`subscribe` functions that return controlled responses or emit fake event sequences.

**Conventions:** `bun:test` runner, `mock.module()` before imports, `createEnvGuard()`/`createTmpDir()` from `@molf-ai/test-utils` for isolation, fake timers for throttle/interval tests, reset spies in `beforeEach`, no real network calls.

**Reference:** OpenClaw (`refs/openclaw/src/telegram/`) has ~47 test files with grammY mocking patterns. Adapt to Bun test conventions.

---

## Post-Implementation: Fixes & Improvements

Items discovered during plan-vs-implementation review.

### 1. WebSocket reconnection (F1) — NOT NEEDED

`@trpc/client` v11's `createWSClient` has built-in reconnection with exponential backoff (0ms → 1s → 2s → ... → 30s cap), automatic resend of pending requests, and connection state tracking. The `client-tui` also relies on this — no custom reconnection logic anywhere in the project. No change needed.

### 2. Update ID deduplication (F2) — NOT NEEDED

grammY's `bot.start()` internally tracks `lastTriedUpdateId` and always polls with `offset = lastTriedUpdateId + 1`. On graceful shutdown it sends a final `getUpdates` to confirm the offset. Duplicate prevention is fully handled by the library. No change needed.

### 3. Fragment buffering bug (F5) — FIX REQUIRED

In `handler.ts:handleMessage()`, lines 52-56 have dead code:
```typescript
const buffer = this.buffers.get(chatId);
if (buffer && text.length >= 4000) {  // BUG: text.length >= 4000 already returned above
```
The intent is: if a buffer is already active for this chat, append ANY subsequent message (regardless of its length) to the buffer. Fix: remove the `text.length >= 4000` condition so shorter follow-up fragments are correctly buffered.

### 4. First chunk replaces draft (F9) — FIX REQUIRED

When content exceeds 4000 chars and a draft exists, `renderer.ts:handleTurnComplete()` currently discards the draft and sends all chunks as new messages. The plan says "First chunk replaces the streaming draft message; subsequent chunks are new messages." This is better UX — the user has been watching the draft update, so editing it with the final first-chunk content preserves visual continuity. Fix: when draft exists and content needs chunking, edit the draft with chunk[0] and send chunk[1..n] as new messages.

### 5. /help pagination (F14) — ADD

The current /help is a static 4-line message that won't exceed Telegram's limit. Add pagination with inline keyboard buttons (`help_page_{n}`) so the command can scale if more commands are added later. Low priority but matches the plan spec.

### 6. Improve test coverage

Current coverage has gaps in several modules. The following need additional tests:

| Module | % Funcs | % Lines | Key uncovered areas |
|--------|---------|---------|---------------------|
| access.ts | 66.67 | 68.42 | `createAccessMiddleware` (grammY middleware creation + next() call) |
| bot.ts | 50.00 | 65.22 | `bot.catch` handler invocation, `start()` with `onStart` callback |
| chunking.ts | 80.00 | 55.41 | Code-fence-aware splitting paths, `findFencePositions`, `findBreakBefore` |
| commands.ts | 92.86 | 93.75 | Error path in `/new` when `createNew` throws |
| connection.ts | 66.67 | 65.12 | `connectToServer` (creates real WS client — needs mock), `subscribeToEvents` |
| format.ts | 100.00 | 90.91 | Edge cases in `findSingleAsteriskEnd`, unclosed italic |
| handler.ts | 88.89 | 28.95 | Fragment buffering paths (buffer append, buffer flush on timeout/overflow, buffer cleanup) |
| renderer.ts | 75.00 | 77.93 | `handleContentDelta` (draft stream creation), `handleToolCallEnd`, `updateToolStatus`, typing indicator interval |
| streaming.ts | 69.23 | 70.53 | Overflow handling, HTML parse error fallback in edit, `scheduleFlush`, `isMessageNotModified` |
| session-map.ts | 88.89 | 96.67 | `setWorkerId` |

After improving coverage, decide whether mock patterns (item 6 of original comparison: `mock.module()` vs injected mocks) and fake timers (item 7) should be adopted. Current approach of injected mock objects works and is simpler; `mock.module()` would only be needed for modules that import grammy at the top level and create real instances. Fake timers would improve streaming/throttle tests but aren't blocking.

---

## Out of Scope (Future)

- Group/channel support
- Multi-account
- Webhook transport
- Media (images, voice, documents)
- Message debouncing (combine rapid short messages)
- Auto-reset sessions
- Pairing workflow for unknown users
- Inline queries
- Custom commands beyond /new, /status, /help
