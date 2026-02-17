# Integration Test Gap Analysis

> Generated 2026-02-17 by cross-referencing all server, agent-core, worker, and protocol features against existing integration tests in `packages/e2e/tests/integration/`.

---

## Existing Integration Test Coverage

The following areas are **already covered** by integration tests:

| Test File | Covers |
|-----------|--------|
| `agent-flow.test.ts` | Text streaming events, tool call round-trip, message persistence |
| `concurrent-sessions.test.ts` | Concurrent CRUD, event bus isolation, rapid subscribe/unsubscribe |
| `context-pruning.test.ts` | Soft/hard pruning, error recovery with aggressive pruning, session integrity |
| `full-flow.test.ts` | Session CRUD, tool list, agent list/status/abort, multi-session per worker |
| `multimodal.test.ts` | File upload, prompt with fileRefs, session persistence of FileRef, Telegram media |
| `router-edge-cases.test.ts` | Pagination, worker rename, abort during streaming, AgentBusy, auth rejection, multi-client events, duplicate worker registration, tool error propagation |
| `server-worker.test.ts` | Worker visibility, session binding, tool discovery, tool approve/deny |
| `server-multi-worker.test.ts` | Multi-worker routing, tool isolation, concurrent dispatch, session filtering by workerId |
| `skills.test.ts` | Skill registration, skill tool invocation, unknown skill error |
| `tool-approval.test.ts` | Approve/deny returns, tool_approval_required event schema |
| `worker-connection.test.ts` | Worker registration, clean disconnect, tool call via dispatch, auth failure |
| `reconnection.test.ts` | Disconnect during tool call, idle cleanup, server restart persistence, new worker after disconnect |
| `telegram-client.test.ts` | SessionMap, event subscription, Renderer, ApprovalManager, MessageHandler |

---

## Missing Integration Tests

### Priority 1 -- High-risk flows with no integration coverage

#### 1. Agent Idle Eviction and Recreation
- **What**: AgentRunner evicts cached agents after 30 min of inactivity (`IDLE_EVICTION_MS`). On next prompt, agent is recreated from disk with full message history.
- **Why it matters**: If eviction or recreation is broken, sessions lose context or leak memory. Currently only exercised implicitly; no test verifies the evict-then-recreate path.
- **Suggested test**: Prompt a session, manually trigger eviction via `agentRunner.evict()`, prompt again, verify full message history is preserved and response is coherent.
- **Server modules**: `AgentRunner.evict()`, `AgentRunner.prompt()` (recreate path), `SessionManager.release()`, `SessionManager.load()`

#### 2. Turn Timeout (10-minute hung tool)
- **What**: If a prompt turn exceeds `TURN_TIMEOUT_MS` (10 min), the agent is aborted automatically.
- **Why it matters**: Prevents the server from being stuck indefinitely on a hung worker. No integration test covers this path.
- **Suggested test**: Register a worker with a tool that never responds, submit a prompt, verify the turn times out and emits an error/abort event. (Use a short timeout override or mock timer.)
- **Server modules**: `AgentRunner.runPrompt()` timeout race, `Agent.abort()`

#### 3. Tool Dispatch Timeout (120s)
- **What**: `WorkerDispatch` rejects tool calls that don't resolve within 120 seconds.
- **Why it matters**: Ensures tool calls don't hang forever. Unit tested in `tool-dispatch.test.ts` but never tested with a real server+worker where the worker simply doesn't respond.
- **Suggested test**: Connect a worker that receives but never resolves tool calls, prompt the agent, verify the tool call times out and the error propagates to the client as an event.
- **Server modules**: `WorkerDispatch.dispatch()`, `ToolDispatch`, `AgentRunner` error handling

#### 4. Upload Timeout (30s)
- **What**: The `agent.upload` router procedure races the upload dispatch against a 30-second timer.
- **Why it matters**: A hanging worker upload should fail gracefully, not block the client. Not tested in integration.
- **Suggested test**: Connect a worker that never resolves uploads, call `agent.upload`, verify `TIMEOUT` TRPCError is returned.
- **Server modules**: `router.ts` upload procedure, `UploadDispatch`

#### 5. Image Re-inlining on Session Resume
- **What**: When a session is resumed (loaded from disk after eviction), `AgentRunner.resolveSessionMessages()` re-inlines cached images from `InlineMediaCache` so the LLM can "see" them again.
- **Why it matters**: Without this, resumed sessions lose visual context. The cache is tested in unit tests; the full flow (upload -> evict -> resume -> re-inline) is not.
- **Suggested test**: Upload image, prompt with fileRef, evict agent, prompt again, verify the image data is re-inlined into the LLM context (check that the agent receives the attachment).
- **Server modules**: `AgentRunner.resolveSessionMessages()`, `InlineMediaCache.load()`, `SessionManager.load()`

#### 6. Doom Loop Detection End-to-End
- **What**: Agent detects 3+ identical consecutive tool calls and injects a warning message. Unit tested in agent-core but never exercised through the full server->worker->agent flow.
- **Why it matters**: In a real integration, the tool call args go through JSON serialization/deserialization across WebSocket; subtle differences could break equality checks.
- **Suggested test**: Mock LLM to repeatedly request the same tool with identical args, connect a real worker, verify the doom loop warning message is injected and persisted in the session.
- **Server modules**: `Agent.detectDoomLoop()`, `AgentRunner`, `ToolDispatch`, worker tool execution

#### 7. MaxSteps Limit End-to-End
- **What**: Agent stops after `maxSteps` iterations (default 10) even if the LLM keeps requesting tool calls. Only unit tested.
- **Why it matters**: Prevents runaway tool loops. In integration, tool dispatch timing and event ordering could cause different behavior than mocked unit tests.
- **Suggested test**: Mock LLM to always request tool calls, set maxSteps to 3, verify exactly 3 tool rounds execute and turn completes with fallback message.
- **Server modules**: `Agent.prompt()` step loop, `AgentRunner.buildRemoteTools()`, session message count

#### 8. Binary Tool Results (Image Inlining)
- **What**: When a tool returns binary image data (e.g., `read_file` on a PNG), `AgentRunner` converts it to an inline model image part. Non-image binary results get a file-data type.
- **Why it matters**: Image tool results are displayed to the LLM as visual content. If the conversion fails, the LLM can't interpret tool output.
- **Suggested test**: Register a tool that returns `{ type: "binary", data: base64, mimeType: "image/png" }`, prompt the agent, verify the result is inlined as an image part (check agent events or session messages).
- **Server modules**: `AgentRunner.buildRemoteTools()` execute callback, image result handling

---

### Priority 2 -- Edge cases with partial or no coverage

#### 9. Agent Error Recovery
- **What**: After an agent enters `error` status (non-context-length error), the next `prompt()` should work (status reset to idle). Error event should be emitted.
- **Current coverage**: `router-edge-cases.test.ts` tests tool error propagation, but doesn't verify recovery (new prompt after error).
- **Suggested test**: Cause an agent error (e.g., via a tool that throws), verify error event, then submit a new prompt and verify it succeeds.

#### 10. Abort During Tool Execution (Not Just Streaming)
- **What**: `agent.abort` while status is `executing_tool` (not just `streaming`). The abort should cancel the pending tool call and the turn.
- **Current coverage**: `router-edge-cases.test.ts` tests abort during streaming. No test for abort during tool execution.
- **Suggested test**: Register a slow tool (delayed response), prompt the agent, wait for `executing_tool` status, call abort, verify the agent transitions to `aborted` and no further events are emitted.

#### 11. Session-Level Config Overrides
- **What**: `session.create` accepts `config: { llm, behavior }` for per-session overrides (temperature, maxSteps, contextPruning, systemPrompt).
- **Current coverage**: `context-pruning.test.ts` passes `behavior.contextPruning`, but no test exercises per-session LLM config (temperature, maxTokens) or systemPrompt override.
- **Suggested test**: Create a session with a custom systemPrompt and maxSteps=2, prompt it, verify the system prompt is used and maxSteps is respected.

#### 12. Worker Reconnect with Changed Tools
- **What**: Worker disconnects and reconnects with a different tool set. The stale connection is cleaned up, and subsequent prompts should use the new tools.
- **Current coverage**: `reconnection.test.ts` tests worker disconnect/reconnect but doesn't verify tool set changes are picked up.
- **Suggested test**: Connect worker with tool_A, disconnect, reconnect with tool_B, prompt the agent, verify tool_B is available and tool_A is not.

#### 13. Non-Image FileRef as Text Hint
- **What**: When a prompt includes a fileRef for a non-image file (e.g., PDF, text), `AgentRunner.resolveFileRef()` returns a text hint like `[Attached file: path]` instead of inline binary data.
- **Current coverage**: `multimodal.test.ts` tests image uploads but not non-image file refs.
- **Suggested test**: Upload a text/plain file, prompt with its fileRef, verify the agent receives a text hint (not binary data).

#### 14. EventBus Cleanup on Session Delete
- **What**: Deleting a session while a client has an active event subscription. The subscription should be cleaned up gracefully.
- **Current coverage**: No test deletes a session while events are actively subscribed.
- **Suggested test**: Subscribe to events on a session, delete the session, verify the subscription ends cleanly without errors.

#### 15. Session List Active Status Accuracy
- **What**: `session.list` determines "active" status by checking `eventBus.hasListeners()` OR `agentRunner.getStatus() !== 'idle'`. This means a session is "active" if anyone is subscribed to its events or if the agent is busy.
- **Current coverage**: No test verifies the `active` filter in `session.list` returns correct results based on subscription/agent state.
- **Suggested test**: Create 2 sessions, subscribe to events on one, prompt the other, call `session.list({ active: true })`, verify both appear. Unsubscribe and wait for idle, verify neither appears as active.

---

### Priority 3 -- Lower-risk gaps

#### 16. System Prompt Building with Worker Metadata
- **What**: `buildAgentSystemPrompt()` incorporates worker metadata: AGENTS.md content, skill hints, workdir path, media handling hints. These are composed into the system prompt sent to the LLM.
- **Current coverage**: Unit tested in `agent-runner.test.ts`. Not verified in integration that the full system prompt arrives at the LLM correctly.
- **Suggested test**: Connect a worker with metadata (agentsDoc, workdir), prompt the session, capture the system prompt passed to `streamText` (via mock), verify it contains all expected sections.

#### 17. Concurrent Tool Dispatches to Same Worker
- **What**: Multiple tool calls dispatched to the same worker in sequence or concurrently. Worker processes them from a queue.
- **Current coverage**: `server-multi-worker.test.ts` tests concurrent dispatch to *different* workers. No test for concurrent dispatch to the *same* worker.
- **Suggested test**: Mock LLM to request 2+ tools in parallel (single step), verify all tool calls are dispatched to and resolved by the same worker, results arrive correctly.

#### 18. Large Session Message History
- **What**: Sessions with hundreds of messages approaching context window limits. Tests memory, serialization, and pruning under load.
- **Current coverage**: No integration test with large message counts.
- **Suggested test**: Pre-populate a session with 100+ messages, prompt it, verify pruning activates correctly and the response succeeds.

#### 19. WebSocket Keep-Alive
- **What**: Server pings every 30s, expects pong within 10s. Stale connections should be terminated.
- **Current coverage**: Not tested. WebSocket keep-alive is configured in `server.ts` but never exercised.
- **Suggested test**: Connect a client, stop responding to pings, verify the connection is terminated after timeout.

#### 20. Auth Token via Environment Variable
- **What**: `MOLF_TOKEN` env var overrides generated token. `initAuth()` uses env token directly without generating a new one.
- **Current coverage**: `auth.test.ts` unit tests this. No integration test verifies the full flow (env var -> server startup -> client auth).
- **Suggested test**: Start server with `MOLF_TOKEN` env var, connect with that token, verify access works. Connect with wrong token, verify rejection.

#### 21. Session Corruption Handling in Integration
- **What**: `SessionManager.load()` throws `SessionCorruptError` when a session file contains invalid JSON. `session.list()` skips corrupt files.
- **Current coverage**: Unit tested in `session-mgr.test.ts`. No integration test corrupts a session file and verifies the error propagates through the router.
- **Suggested test**: Create a session, manually corrupt its JSON file, call `session.load`, verify `INTERNAL_SERVER_ERROR`. Call `session.list`, verify the corrupt session is skipped.

#### 22. Worker Identity Persistence
- **What**: Worker generates a persistent UUID stored in `<workdir>/.molf/worker.json`. Same workdir always produces the same worker ID.
- **Current coverage**: Unit tested in `identity.ts`. Not tested in integration that a worker reconnecting from the same workdir gets the same ID.
- **Suggested test**: Start worker, note its ID, stop it, restart from same workdir, verify same ID is used for registration.

#### 23. Skill Content in Multi-Turn Conversation
- **What**: Skill tool is invoked, returns skill content, LLM processes it. In subsequent turns, the skill content is persisted in session messages.
- **Current coverage**: `skills.test.ts` tests single skill invocation. No test verifies skill content persistence across turns.
- **Suggested test**: Prompt to invoke a skill, then prompt again referencing the skill content, verify the skill result is in the session history.

#### 24. InlineMediaCache FIFO Eviction Under Pressure
- **What**: Cache evicts oldest entries when total size exceeds 200MB. During a multi-image conversation, old images should be evicted.
- **Current coverage**: Unit tested in `inline-media-cache.test.ts`. No integration test verifies behavior when cache is full during real upload+prompt flow.
- **Suggested test**: Upload images until cache is near capacity, upload one more, verify oldest image is evicted and no longer inlinable on session resume.

#### 25. Prompt with Empty Text and FileRef Only
- **What**: Schema allows prompt with empty text but non-empty fileRefs. Agent should process attachments without text.
- **Current coverage**: `multimodal.test.ts` has a test for "fileRef but empty text" but only verifies no error. Doesn't verify the LLM receives the image.
- **Suggested test**: Prompt with empty text and an image fileRef, verify the agent receives the image attachment and produces a response.

---

## Summary by Risk Level

| Priority | Count | Description |
|----------|-------|-------------|
| **P1** | 8 | High-risk flows with no integration coverage (timeouts, eviction, doom loop, binary results) |
| **P2** | 7 | Edge cases with partial coverage (error recovery, abort during tool, config overrides, tool changes) |
| **P3** | 10 | Lower-risk gaps (system prompt, concurrent dispatch, large sessions, keep-alive, auth env var) |

**Total: 25 identified gaps**
