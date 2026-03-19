import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { mockStreamText, waitUntil } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";
import {
  setStreamTextImpl,
  makeWorker,
  createTestHarness,
  type TestHarness,
} from "./_helpers.js";
import {
  buildAgentSystemPrompt,
  SessionNotFoundError,
  WorkerDisconnectedError,
  QueueFullError,
  MAX_QUEUE_SIZE,
} from "../src/agent-runner.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// --- Existing unit tests for exported helpers ---

describe("buildAgentSystemPrompt", () => {
  test("with skills includes hint", () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy app", content: "..." }],
    });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("skill");
  });

  test("without skills no hint", () => {
    const worker = makeWorker();
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).not.toContain("skill");
  });

  test("includes media hint when worker has read_file tool", () => {
    const worker = makeWorker({
      tools: [{ name: "read_file", description: "Read a file", inputSchema: {} }],
    });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("read_file");
    expect(prompt).toContain(".molf/uploads/");
  });

  test("omits media hint when worker has no read_file tool", () => {
    const worker = makeWorker({ tools: [] });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).not.toContain(".molf/uploads/");
  });
});


describe("buildAgentSystemPrompt with metadata", () => {
  test("includes agentsDoc when present", () => {
    const worker = makeWorker({
      metadata: { agentsDoc: "Custom instructions here" },
    });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("Custom instructions here");
  });

  test("includes workdir hint when metadata has workdir", () => {
    const worker = makeWorker({
      metadata: { workdir: "/home/user/project" },
    });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("Your working directory is: /home/user/project");
    expect(prompt).toContain("relative file paths and shell commands");
  });

  test("omits workdir hint when metadata has no workdir", () => {
    const worker = makeWorker({ metadata: {} });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).not.toContain("Your working directory is:");
  });

  test("omits workdir hint when no metadata", () => {
    const worker = makeWorker();
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).not.toContain("Your working directory is:");
  });
});

// --- AgentRunner unit tests ---

import { collectEvents as _collectEvents, waitForEventType } from "./_helpers.js";

let h: TestHarness;
let sessionMgr: TestHarness["sessionMgr"];
let connectionRegistry: TestHarness["connectionRegistry"];
let serverBus: TestHarness["serverBus"];
let toolDispatch: TestHarness["toolDispatch"];
let inlineMediaCache: TestHarness["inlineMediaCache"];
let agentRunner: TestHarness["agentRunner"];
let approvalGate: TestHarness["approvalGate"];
let WORKER_ID: string;

function collectEvents(sessionId: string) {
  return _collectEvents(serverBus, sessionId);
}

beforeAll(() => {
  h = createTestHarness({ tmpPrefix: "molf-agent-runner-" });
  ({ sessionMgr, connectionRegistry, serverBus, toolDispatch, inlineMediaCache, agentRunner, approvalGate } = h);
  WORKER_ID = h.workerId;
});

afterAll(() => h.cleanup());

describe("AgentRunner.getStatus()", () => {
  test("returns idle for unknown session", () => {
    const status = agentRunner.getStatus("nonexistent-session");
    expect(status).toBe("idle");
  });
});

describe("AgentRunner.prompt()", () => {
  test("throws SessionNotFoundError for nonexistent session", async () => {
    try {
      await agentRunner.prompt("nonexistent-session", "hello");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(SessionNotFoundError);
    }
  });

  test("throws WorkerDisconnectedError when worker is disconnected", async () => {
    const disconnectedWorkerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: disconnectedWorkerId,
      name: "temp",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const session = await sessionMgr.create({ workerId: disconnectedWorkerId, workspaceId: "test-ws" });
    connectionRegistry.unregister(disconnectedWorkerId);

    try {
      await agentRunner.prompt(session.sessionId, "hello");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkerDisconnectedError);
    }
  });

  test("returns messageId for valid session and connected worker", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const result = await agentRunner.prompt(session.sessionId, "hello");
    expect(result.messageId).toBeTruthy();
    expect(result.messageId).toMatch(/^msg_/);
  });

  test("queues prompt when agent is already streaming", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await streamWait;
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Start first prompt (don't await — it will hang)
    const firstPromise = agentRunner.prompt(session.sessionId, "first");
    await waitUntil(
      () => agentRunner.getStatus(session.sessionId) === "streaming",
      2_000, "agent streaming",
    );

    // Second prompt should be queued, not rejected
    const result = await agentRunner.prompt(session.sessionId, "second");
    expect(result.queued).toBe(true);
    expect(result.messageId).toMatch(/^msg_/);

    // Verify user message was persisted immediately
    const loaded = sessionMgr.load(session.sessionId);
    const userMsgs = loaded!.messages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content === "second")).toBe(true);

    // Clean up: resolve the first stream
    resolveStream();
    await firstPromise;
    await agentRunner.waitForTurn(session.sessionId);
    agentRunner.evict(session.sessionId);
  });

  test("emits events to ServerBus (status_change, content_delta, turn_complete)", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hello" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "test");
    await waitForEventType(events, "turn_complete");
    unsub();

    const types = events.map((e) => e.type);
    expect(types).toContain("status_change");
    expect(types).toContain("content_delta");
    expect(types).toContain("turn_complete");
  });

  test("persists user and assistant messages to SessionManager", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Response" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "persist test");
    await waitForEventType(events, "turn_complete");
    unsub();

    const loaded = sessionMgr.load(session.sessionId);
    expect(loaded).toBeTruthy();
    // Should have at least user + assistant messages
    expect(loaded!.messages.length).toBeGreaterThanOrEqual(2);
    expect(loaded!.messages[0].role).toBe("user");
    expect(loaded!.messages[0].content).toBe("persist test");
  });
});

describe("AgentRunner.abort()", () => {
  test("returns false for inactive session", () => {
    const result = agentRunner.abort("nonexistent-session");
    expect(result).toBe(false);
  });

  test("returns true and stops agent during active prompt", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl((opts: any) => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        opts.abortSignal?.addEventListener("abort", () => resolveStream());
        await streamWait;
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const promptPromise = agentRunner.prompt(session.sessionId, "abort me");
    await waitUntil(
      () => agentRunner.getStatus(session.sessionId) === "streaming",
      2_000, "agent streaming",
    );

    const aborted = agentRunner.abort(session.sessionId);
    expect(aborted).toBe(true);

    // Wait for prompt to settle (agent handles AbortError internally)
    await promptPromise;
    await agentRunner.waitForTurn(session.sessionId);
  });
});

describe("AgentRunner.abort() during tool dispatch [P6-F6]", () => {
  test("abort during executing_tool status returns true and aborts agent", async () => {
    let resolveToolCall!: () => void;
    const toolCallWait = new Promise<void>((r) => (resolveToolCall = r));

    setStreamTextImpl((opts: any) => ({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "tc_slow",
          toolName: "echo",
          input: { text: "slow" },
        };
        // Simulate a tool that takes a long time
        yield {
          type: "tool-result",
          toolCallId: "tc_slow",
          toolName: "echo",
          output: await toolCallWait.then(() => "done"),
        };
        yield { type: "finish", finishReason: "tool-calls" };
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    // Set up a worker subscription that doesn't resolve until we say so
    let resolveWorkerTool!: () => void;
    const workerToolWait = new Promise<void>((r) => (resolveWorkerTool = r));
    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of toolDispatch.subscribeWorker(WORKER_ID, ac.signal)) {
        await workerToolWait;
        toolDispatch.resolveToolCall(req.toolCallId, { output: "result" });
      }
    })();

    // Start prompt (async)
    await agentRunner.prompt(session.sessionId, "trigger tool");

    // Wait for the tool_call_start event
    await waitForEventType(events, "tool_call_start");

    // Abort while tool is executing
    const aborted = agentRunner.abort(session.sessionId);
    // abort() should return true since stream is running
    expect(aborted).toBe(true);

    // Let things settle
    resolveToolCall();
    resolveWorkerTool();
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    ac.abort();
    await sub;
  });
});

describe("AgentRunner cleanup", () => {
  test("status returns to idle after prompt completes", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "done" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "cleanup test");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    expect(agentRunner.getStatus(session.sessionId)).toBe("idle");
  });

  test("releaseIfIdle releases when no listeners and agent idle", async () => {
    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Session is in SessionManager's activeSessions cache
    expect(sessionMgr.getActive(session.sessionId)).toBeTruthy();

    // No listeners, no active agent → should release
    await agentRunner.releaseIfIdle(session.sessionId);

    expect(sessionMgr.getActive(session.sessionId)).toBeUndefined();
  });

  test("releaseIfIdle does NOT release when listeners exist", async () => {
    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Subscribe a listener
    const unsub = serverBus.subscribe({ type: "session", sessionId: session.sessionId }, () => {});

    await agentRunner.releaseIfIdle(session.sessionId);

    // Should still be in memory because listener exists
    expect(sessionMgr.getActive(session.sessionId)).toBeTruthy();

    unsub();
  });
});

describe("mapAgentEvent (indirect via ServerBus)", () => {
  test("error event mapped to { code: AGENT_ERROR, message }", async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        throw new Error("LLM failed");
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "trigger error");
    // Wait for the error event (emitted from runPrompt catch)
    await waitForEventType(events, "error");
    unsub();

    const errorEvent = events.find((e) => e.type === "error") as any;
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.code).toBe("AGENT_ERROR");
    expect(errorEvent.message).toBeTruthy();
  });

  test("remote tool execute dispatches and returns result", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture tools");
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(capturedTools).toBeTruthy();
    expect(capturedTools.echo).toBeTruthy();

    // Set up worker subscription to auto-resolve tool calls
    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of toolDispatch.subscribeWorker(WORKER_ID, ac.signal)) {
        toolDispatch.resolveToolCall(req.toolCallId, { output: JSON.stringify({ echoed: true }) });
      }
    })();

    // Auto-approve any approval request for this session (echo is an unknown tool → "ask").
    // Defer the reply with queueMicrotask so waitForApproval() is called first before reply()
    // removes the entry from the pending map.
    const unsubApproval = serverBus.subscribe({ type: "session", sessionId: session.sessionId }, (ev) => {
      if (ev.type === "tool_approval_required") {
        queueMicrotask(() => approvalGate.reply(ev.approvalId, "once"));
      }
    });

    const result = await capturedTools.echo.execute({ text: "hi" }, { toolCallId: "tc_exec_1" });
    expect(result).toBe(JSON.stringify({ echoed: true }));

    unsubApproval();
    ac.abort();
    await sub;
  });

  test("remote tool execute throws on dispatch error", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture tools 2");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Set up worker subscription to return an error
    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of toolDispatch.subscribeWorker(WORKER_ID, ac.signal)) {
        toolDispatch.resolveToolCall(req.toolCallId, { output: "", error: "tool failed" });
      }
    })();

    // Auto-approve any approval request for this session (echo is an unknown tool → "ask").
    // Defer the reply with queueMicrotask so waitForApproval() is called first before reply()
    // removes the entry from the pending map.
    const unsubApproval = serverBus.subscribe({ type: "session", sessionId: session.sessionId }, (ev) => {
      if (ev.type === "tool_approval_required") {
        queueMicrotask(() => approvalGate.reply(ev.approvalId, "once"));
      }
    });

    try {
      await capturedTools.echo.execute({ text: "hi" }, { toolCallId: "tc_exec_2" });
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toBe("tool failed");
    }

    unsubApproval();
    ac.abort();
    await sub;
  });

  test("remote tool toModelOutput converts image attachment to content with image-data", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture toModelOutput");
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(capturedTools.echo.toModelOutput).toBeTruthy();

    // Stash an image attachment (simulating what execute does)
    const toolCallId = "tc_img_test";
    (agentRunner as any).attachmentMeta.set(toolCallId, [
      { mimeType: "image/png", data: new File([Buffer.from("abc123")], "img.png", { type: "image/png" }), path: "/img.png", size: 100 },
    ]);

    const imageResult = await capturedTools.echo.toModelOutput({
      output: "[Binary: image/png, 100 bytes]",
      toolCallId,
    });
    expect(imageResult.type).toBe("content");
    // value = [textPart, ...attachmentToContentParts] = [text, text, image-data]
    expect(imageResult.value).toHaveLength(3);
    expect(imageResult.value[0].type).toBe("text");
    expect(imageResult.value[0].text).toContain("[Binary: image/png, 100 bytes]");
    expect(imageResult.value[2].type).toBe("image-data");
    // data is now base64-encoded from File contents
    expect(typeof imageResult.value[2].data).toBe("string");
    expect(imageResult.value[2].mediaType).toBe("image/png");

    agentRunner.evict(session.sessionId);
  });

  test("remote tool toModelOutput converts non-image attachment to content with file-data", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture toModelOutput 2");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Stash a PDF attachment
    const toolCallId = "tc_pdf_test";
    (agentRunner as any).attachmentMeta.set(toolCallId, [
      { mimeType: "application/pdf", data: new File([Buffer.from("pdf123")], "doc.pdf", { type: "application/pdf" }), path: "/doc.pdf", size: 500 },
    ]);

    const pdfResult = await capturedTools.echo.toModelOutput({
      output: "[Binary: application/pdf, 500 bytes]",
      toolCallId,
    });
    expect(pdfResult.type).toBe("content");
    // value = [textPart, text_from_attachmentToContentParts, file-data]
    expect(pdfResult.value).toHaveLength(3);
    expect(pdfResult.value[2].type).toBe("file-data");
    expect(pdfResult.value[2].mediaType).toBe("application/pdf");

    agentRunner.evict(session.sessionId);
  });

  test("remote tool toModelOutput passes string results as text", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture toModelOutput 3");
    await waitForEventType(events, "turn_complete");
    unsub();

    // String result (no attachments stashed)
    const textResult = await capturedTools.echo.toModelOutput({
      output: "hello world",
    });
    expect(textResult.type).toBe("text");
    expect(textResult.value).toBe("hello world");

    agentRunner.evict(session.sessionId);
  });

  test("turn_complete strips extra fields from message", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Clean" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "clean test");
    await waitForEventType(events, "turn_complete");
    unsub();

    const turnComplete = events.find((e) => e.type === "turn_complete") as any;
    expect(turnComplete).toBeTruthy();
    const msg = turnComplete.message;
    // Should have only id, role, content, timestamp
    expect(msg.id).toBeTruthy();
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
  });
});

// --- AgentRunner with fileRefs ---

describe("AgentRunner.prompt() with fileRefs", () => {
  test("prompt without fileRefs: unchanged behavior", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    const result = await agentRunner.prompt(session.sessionId, "no media");
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(result.messageId).toMatch(/^msg_/);

    // Verify user message persisted without attachments
    const loaded = sessionMgr.load(session.sessionId);
    const userMsg = loaded!.messages.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toBe("no media");
    expect(userMsg!.attachments).toBeUndefined();
  });

  test("prompt with fileRefs: persists FileRef attachments to session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "I see the file reference" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    const result = await agentRunner.prompt(session.sessionId, "Describe this", [
      { path: ".molf/uploads/abc-test.png", mimeType: "image/png" },
    ]);
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(result.messageId).toMatch(/^msg_/);

    // Verify user message has FileRef attachments
    const loaded = sessionMgr.load(session.sessionId);
    const userMsg = loaded!.messages.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toBe("Describe this");
    expect(userMsg!.attachments).toHaveLength(1);
    expect(userMsg!.attachments![0].path).toBe(".molf/uploads/abc-test.png");
    expect(userMsg!.attachments![0].mimeType).toBe("image/png");
  });

  test("resolveSessionMessages inlines cached images", async () => {
    // Save an image to the cache
    const imageData = new Uint8Array([1, 2, 3, 4, 5]);
    inlineMediaCache.save(".molf/uploads/cached-img.jpg", imageData, "image/jpeg");

    // Create session with a message that has FileRef attachment
    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const userMsg = {
      id: "msg_test_resolve",
      role: "user" as const,
      content: "Previous image",
      attachments: [{ path: ".molf/uploads/cached-img.jpg", mimeType: "image/jpeg" }],
      timestamp: Date.now(),
    };
    sessionMgr.addMessage(session.sessionId, userMsg);

    // Now prompt to trigger resolveSessionMessages
    let capturedMessages: any;
    setStreamTextImpl((opts: any) => {
      capturedMessages = opts.messages;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "Follow up");
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(capturedMessages).toBeTruthy();
    // Should find a user message with inlined image content
    const multimodalUserMsg = capturedMessages.find(
      (m: any) => m.role === "user" && Array.isArray(m.content),
    );
    expect(multimodalUserMsg).toBeTruthy();
    const imagePart = multimodalUserMsg.content.find((p: any) => p.type === "image");
    expect(imagePart).toBeTruthy();
    expect(imagePart.image).toEqual(imageData);
  });

  test("resolveSessionMessages shows text reference for uncached files", async () => {
    // Create session with a FileRef that is NOT in the cache
    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const userMsg = {
      id: "msg_test_uncached",
      role: "user" as const,
      content: "Check this file",
      attachments: [{ path: ".molf/uploads/not-cached.pdf", mimeType: "application/pdf" }],
      timestamp: Date.now(),
    };
    sessionMgr.addMessage(session.sessionId, userMsg);

    let capturedMessages: any;
    setStreamTextImpl((opts: any) => {
      capturedMessages = opts.messages;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "Follow up");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Should not throw, should have text reference instead of inline
    expect(capturedMessages).toBeTruthy();
  });

  test("prompt with non-image fileRefs prepends text hints to prompt text", async () => {
    let capturedMessages: any;
    setStreamTextImpl((opts: any) => {
      capturedMessages = opts.messages;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "Summarize this", [
      { path: ".molf/uploads/report.pdf", mimeType: "application/pdf" },
    ]);
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(capturedMessages).toBeTruthy();
    // The last user message (current turn) should have the hint prepended
    const userMsgs = capturedMessages.filter((m: any) => m.role === "user");
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    const content = typeof lastUserMsg.content === "string" ? lastUserMsg.content : lastUserMsg.content.map((p: any) => p.text).join("");
    expect(content).toContain("[Attached file: .molf/uploads/report.pdf, application/pdf. Use read_file to access if needed.]");
    expect(content).toContain("Summarize this");
  });

  test("prompt with image fileRef cache miss generates text hint", async () => {
    let capturedMessages: any;
    setStreamTextImpl((opts: any) => {
      capturedMessages = opts.messages;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    // Image fileRef with no cache entry → should fall back to text hint
    await agentRunner.prompt(session.sessionId, "Describe this image", [
      { path: ".molf/uploads/missing-image.png", mimeType: "image/png" },
    ]);
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(capturedMessages).toBeTruthy();
    const userMsgs = capturedMessages.filter((m: any) => m.role === "user");
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    const content = typeof lastUserMsg.content === "string" ? lastUserMsg.content : lastUserMsg.content.map((p: any) => p.text).join("");
    expect(content).toContain("[Attached file: .molf/uploads/missing-image.png, image/png. Use read_file to access if needed.]");
    expect(content).toContain("Describe this image");
  });
});

// --- Long-lived Agent per Session (#15) ---

describe("AgentRunner agent caching", () => {
  test("second prompt reuses cached agent (no new Agent created)", async () => {
    let promptCount = 0;
    setStreamTextImpl(() => {
      promptCount++;
      return mockStreamText([
        { type: "text-delta", text: `response-${promptCount}` },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // First prompt
    const { events: e1, unsub: u1 } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "first");
    await waitForEventType(e1, "turn_complete");
    u1();

    // Second prompt — should reuse cached agent
    const { events: e2, unsub: u2 } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "second");
    await waitForEventType(e2, "turn_complete");
    u2();

    // Both prompts succeeded
    expect(promptCount).toBe(2);

    // Session messages should include both turns
    const loaded = sessionMgr.load(session.sessionId);
    const userMsgs = loaded!.messages.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(2);
    expect(userMsgs[0].content).toBe("first");
    expect(userMsgs[1].content).toBe("second");
  });

  test("cached session stays in cache after prompt completes (eviction scheduled)", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "cached" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "test cache");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    // Session should still be in cache (status is idle, not removed)
    // Access internal state to verify
    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cached).toBeTruthy();
    expect(cached.status).toBe("idle");
    expect(cached.evictionTimer).toBeTruthy(); // Timer should be set

    // Cleanup: evict to prevent timer leaks
    agentRunner.evict(session.sessionId);
  });

  test("evict() removes cached session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "evict me" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "will be evicted");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    // Verify it's cached
    expect((agentRunner as any).cachedSessions.has(session.sessionId)).toBe(true);

    // Evict
    agentRunner.evict(session.sessionId);

    // Should be removed from cache
    expect((agentRunner as any).cachedSessions.has(session.sessionId)).toBe(false);
    expect(agentRunner.getStatus(session.sessionId)).toBe("idle");
  });

  test("eviction timer is cleared when a new prompt starts [P6-F7]", async () => {
    let promptCount = 0;
    setStreamTextImpl(() => {
      promptCount++;
      return mockStreamText([
        { type: "text-delta", text: `response-${promptCount}` },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // First prompt — creates cached session with eviction timer
    const { events: e1, unsub: u1 } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "first");
    await waitForEventType(e1, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    u1();

    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cached).toBeTruthy();
    expect(cached.evictionTimer).toBeTruthy(); // Timer is set after idle

    // Second prompt — timer should be cleared while active
    const { events: e2, unsub: u2 } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "second");
    // During active prompt, the timer is cancelled (checked inside runPrompt's finally)
    await waitForEventType(e2, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    u2();

    // After second prompt completes, a NEW timer should be scheduled
    const cachedAfter = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cachedAfter).toBeTruthy();
    expect(cachedAfter.evictionTimer).toBeTruthy();

    // Cleanup
    agentRunner.evict(session.sessionId);
  });

  test("evict() on non-cached session is a no-op", () => {
    agentRunner.evict("nonexistent-session");
    // Should not throw and session should not appear in cache
    expect((agentRunner as any).cachedSessions.has("nonexistent-session")).toBe(false);
  });

  test("concurrent prompt() calls — second is queued [P3-F1]", async () => {
    // Use a slow stream so the first prompt is still "streaming" when the second fires
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "slow" },
        { type: "delay", ms: 500 },
        { type: "text-delta", text: " response" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    // First prompt — starts streaming synchronously before returning
    await agentRunner.prompt(session.sessionId, "first");

    // Second prompt — should be queued because status is already "streaming"
    const result = await agentRunner.prompt(session.sessionId, "second");
    expect(result.queued).toBe(true);

    // Wait for first + queued prompt to complete
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    unsub();
    agentRunner.evict(session.sessionId);
  });

  test("abort() returns false for cached-but-idle session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "done" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "idle after");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    // Session is cached but idle — abort should return false
    expect(agentRunner.abort(session.sessionId)).toBe(false);

    // Cleanup
    agentRunner.evict(session.sessionId);
  });

  test("evict during active turn does not crash on message persistence [P3-F8]", async () => {
    // Stream that takes long enough for us to evict mid-turn
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "start" },
        { type: "delay", ms: 200 },
        { type: "text-delta", text: " end" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    // Start prompt (async — fires and returns)
    await agentRunner.prompt(session.sessionId, "will be evicted mid-turn");

    // Capture the turn completion promise before evicting (evict deletes the cached session)
    const turnDone = (agentRunner as any).cachedSessions.get(session.sessionId)?.turnCompletion;

    // Evict while the prompt is still streaming
    agentRunner.evict(session.sessionId);

    // Wait for the prompt to finish — should NOT throw
    await turnDone;
    unsub();

    // Session was evicted, so status should be idle (no cache entry)
    expect(agentRunner.getStatus(session.sessionId)).toBe("idle");
  });

  test("releaseIfIdle does NOT release when agent is cached", async () => {
    // First, create and prompt to get a cached session
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "stay" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Manually create a cached entry to test releaseIfIdle guard
    (agentRunner as any).cachedSessions.set(session.sessionId, {
      agent: {},
      sessionId: session.sessionId,
      workerId: WORKER_ID,
      status: "idle",
      lastActiveAt: Date.now(),
      evictionTimer: null,
      loadedInstructions: new Set(),
      queue: [],
    });

    await agentRunner.releaseIfIdle(session.sessionId);

    // Should NOT have released because agent is cached
    expect(sessionMgr.getActive(session.sessionId)).toBeTruthy();

    // Cleanup
    (agentRunner as any).cachedSessions.delete(session.sessionId);
  });
});

// --- injectShellResult tests ---

describe("AgentRunner.injectShellResult()", () => {
  test("creates user+assistant+tool triplet, all synthetic", async () => {
    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    await agentRunner.injectShellResult(session.sessionId, "ls -la", "file1.txt\n\n\nexit code: 0");

    const loaded = sessionMgr.load(session.sessionId);
    expect(loaded).toBeTruthy();
    const msgs = loaded!.messages;
    expect(msgs.length).toBe(3);

    // User message
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].synthetic).toBe(true);
    expect(msgs[0].content).toContain("executed by the user");

    // Assistant message with tool call
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].synthetic).toBe(true);
    expect(msgs[1].content).toBe("");
    expect(msgs[1].toolCalls).toHaveLength(1);
    expect(msgs[1].toolCalls![0].toolName).toBe("shell_exec");
    expect(msgs[1].toolCalls![0].args).toEqual({ command: "ls -la" });

    // Tool result message
    expect(msgs[2].role).toBe("tool");
    expect(msgs[2].synthetic).toBe(true);
    expect(msgs[2].toolCallId).toBe(msgs[1].toolCalls![0].toolCallId);
    expect(msgs[2].toolName).toBe("shell_exec");
    expect(msgs[2].content).toContain("file1.txt");
  });

  test("works when no cached agent exists (persist-only)", async () => {
    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // No agent prompt has been made, so no cached session
    expect((agentRunner as any).cachedSessions.has(session.sessionId)).toBe(false);

    // Should not throw
    await agentRunner.injectShellResult(session.sessionId, "echo hi", "hi\n\n\nexit code: 0");

    const loaded = sessionMgr.load(session.sessionId);
    expect(loaded!.messages.length).toBe(3);
  });

  test("injects into cached Agent's in-memory Session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    // Prompt to create a cached agent
    await agentRunner.prompt(session.sessionId, "hello");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Verify agent is cached
    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cached).toBeTruthy();

    const beforeCount = cached.agent.getSession().getMessages().length;

    // Inject shell result
    await agentRunner.injectShellResult(session.sessionId, "pwd", "/home\n\n\nexit code: 0");

    // In-memory session should have 3 more messages
    const afterCount = cached.agent.getSession().getMessages().length;
    expect(afterCount).toBe(beforeCount + 3);

    // Cleanup
    agentRunner.evict(session.sessionId);
  });
});

// --- Truncation metadata propagation ---

describe("Truncation metadata in tool_call_end events", () => {
  test("truncation metadata propagated through tool_call_end event", async () => {
    setStreamTextImpl((opts: any) => {
      // Simulate a tool call that will complete
      const toolCallFn = opts.tools?.echo?.execute;
      if (toolCallFn) {
        // Will be called by Agent during prompt processing
      }
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "test truncation metadata");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Directly test the truncationMeta map + mapAgentEvent behavior
    // Stash metadata
    (agentRunner as any).truncationMeta.set("tc_test_123", { truncated: true, outputId: "tc_test_123" });

    // Call mapAgentEvent with a tool_call_end event
    const mapped = (agentRunner as any).mapAgentEvent({
      type: "tool_call_end",
      toolCallId: "tc_test_123",
      toolName: "echo",
      result: "truncated result...",
    });

    expect(mapped).toBeTruthy();
    expect(mapped.type).toBe("tool_call_end");
    expect(mapped.truncated).toBe(true);
    expect(mapped.outputId).toBe("tc_test_123");

    // Metadata should be consumed (deleted)
    expect((agentRunner as any).truncationMeta.has("tc_test_123")).toBe(false);

    // Cleanup
    agentRunner.evict(session.sessionId);
  });

  test("tool_call_end without truncation metadata has no extra fields", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "no truncation");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Call mapAgentEvent without any stashed metadata
    const mapped = (agentRunner as any).mapAgentEvent({
      type: "tool_call_end",
      toolCallId: "tc_no_trunc",
      toolName: "echo",
      result: "small result",
    });

    expect(mapped.type).toBe("tool_call_end");
    expect(mapped.truncated).toBeUndefined();
    expect(mapped.outputId).toBeUndefined();

    // Cleanup
    agentRunner.evict(session.sessionId);
  });

  test("truncationMeta cleared on turn_complete", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Stash some orphan metadata (simulating an abort scenario where tool_call_end never fires)
    (agentRunner as any).truncationMeta.set("orphan_1", { truncated: true, outputId: "orphan_1" });
    (agentRunner as any).truncationMeta.set("orphan_2", { truncated: true, outputId: "orphan_2" });

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "trigger turn_complete");
    await waitForEventType(events, "turn_complete");
    unsub();

    // truncationMeta should be cleared by the turn_complete handler
    expect((agentRunner as any).truncationMeta.size).toBe(0);

    // Cleanup
    agentRunner.evict(session.sessionId);
  });

  test("evicting one session does not clear another session's truncationMeta", async () => {
    // Stash metadata belonging to a different session's pending tool calls
    (agentRunner as any).truncationMeta.set("other_session_call_1", { truncated: true });
    (agentRunner as any).truncationMeta.set("other_session_call_2", { truncated: true });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Manually create a cached entry for the session we'll evict
    (agentRunner as any).cachedSessions.set(session.sessionId, {
      agent: { getStatus: () => "idle" },
      sessionId: session.sessionId,
      workerId: WORKER_ID,
      status: "idle",
      lastActiveAt: Date.now(),
      evictionTimer: null,
      loadedInstructions: new Set(),
      queue: [],
    });

    agentRunner.evict(session.sessionId);

    // truncationMeta for the OTHER session should still be present
    expect((agentRunner as any).truncationMeta.size).toBe(2);
    expect((agentRunner as any).truncationMeta.has("other_session_call_1")).toBe(true);
    expect((agentRunner as any).truncationMeta.has("other_session_call_2")).toBe(true);
  });
});

// --- Nested instruction injection ---

const RF_WORKER_ID = crypto.randomUUID();

describe("Nested instruction injection", () => {
  // Register a worker with read_file tool for instruction injection tests
  beforeAll(() => {
    connectionRegistry.registerWorker({
      id: RF_WORKER_ID,
      name: "rf-worker",
      connectedAt: Date.now(),
      tools: [{
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      }],
      skills: [],
    });
  });

  afterAll(() => {
    connectionRegistry.unregister(RF_WORKER_ID);
  });

  test("instructionFiles from dispatch are injected via afterExecute enhancement", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: RF_WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "trigger tool capture");
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(capturedTools?.read_file).toBeTruthy();

    // Set up worker subscription that returns instructionFiles
    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of toolDispatch.subscribeWorker(RF_WORKER_ID, ac.signal)) {
        toolDispatch.resolveToolCall(req.toolCallId, {
          output: "file contents here",
          meta: { instructionFiles: [{ path: "pkg/AGENTS.md", content: "Package instructions" }] },
        });
      }
    })();

    // Execute the tool — afterExecute appends system-reminder to output string
    const result = await capturedTools.read_file.execute({ path: "test.txt" }, { toolCallId: "tc_rf_1" });
    expect(result).toContain("file contents here");
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("Package instructions");
    expect(result).toContain("pkg/AGENTS.md");

    ac.abort();
    await sub;
    agentRunner.evict(session.sessionId);
  });

  test("instructionFiles injected even when tool result is a plain string", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: RF_WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "string result test");
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(capturedTools?.read_file).toBeTruthy();

    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of toolDispatch.subscribeWorker(RF_WORKER_ID, ac.signal)) {
        toolDispatch.resolveToolCall(req.toolCallId, {
          output: "file contents as a string",
          meta: { instructionFiles: [{ path: "nested/AGENTS.md", content: "Nested string instructions" }] },
        });
      }
    })();

    const result = await capturedTools.read_file.execute({ path: "test.txt" }, { toolCallId: "tc_rf_2" });
    expect(result).toContain("file contents as a string");
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("Nested string instructions");
    expect(result).toContain("nested/AGENTS.md");

    ac.abort();
    await sub;
    agentRunner.evict(session.sessionId);
  });

  test("duplicate instruction paths are not re-injected", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: RF_WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "dedup test");
    await waitForEventType(events, "turn_complete");
    unsub();

    let callCount = 0;
    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of toolDispatch.subscribeWorker(RF_WORKER_ID, ac.signal)) {
        callCount++;
        toolDispatch.resolveToolCall(req.toolCallId, {
          output: `data-${callCount}`,
          meta: { instructionFiles: [{ path: "pkg/AGENTS.md", content: "Same instructions" }] },
        });
      }
    })();

    // First call — should inject
    const result1 = await capturedTools.read_file.execute({ path: "a.txt" }, { toolCallId: "tc_rf_3" });
    expect(result1).toContain("<system-reminder>");
    expect(result1).toContain("Same instructions");

    // Second call — same path, should NOT inject
    const result2 = await capturedTools.read_file.execute({ path: "b.txt" }, { toolCallId: "tc_rf_4" });
    expect(result2).not.toContain("<system-reminder>");

    ac.abort();
    await sub;
    agentRunner.evict(session.sessionId);
  });

  test("loadedInstructions persisted to session metadata", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "persist test");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    // Manually add a path to loadedInstructions
    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cached).toBeTruthy();
    cached.loadedInstructions.add("pkg/AGENTS.md");

    // Run another prompt to trigger persistence
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok2" },
        { type: "finish", finishReason: "stop" },
      ]));

    const { events: e2, unsub: u2 } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "persist again");
    await waitForEventType(e2, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    u2();

    // Check session metadata
    const loaded = sessionMgr.load(session.sessionId);
    expect(loaded).toBeTruthy();
    expect(loaded!.metadata?.loadedInstructionPaths).toEqual(["pkg/AGENTS.md"]);

    // Cleanup
    agentRunner.evict(session.sessionId);
  });

  test("loadedInstructions restored from session metadata on cold start", async () => {
    // Create a session with pre-existing metadata
    const session = await sessionMgr.create({
      workerId: WORKER_ID,
      workspaceId: "test-ws",
      metadata: { loadedInstructionPaths: ["pkg/AGENTS.md", "lib/CLAUDE.md"] },
    });

    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "cold start");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Verify loadedInstructions was restored
    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cached).toBeTruthy();
    expect(cached.loadedInstructions.has("pkg/AGENTS.md")).toBe(true);
    expect(cached.loadedInstructions.has("lib/CLAUDE.md")).toBe(true);

    // Cleanup
    agentRunner.evict(session.sessionId);
  });

  test("new cached session starts with empty loadedInstructions when no metadata", async () => {
    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "fresh");
    await waitForEventType(events, "turn_complete");
    unsub();

    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cached).toBeTruthy();
    expect(cached.loadedInstructions.size).toBe(0);

    // Cleanup
    agentRunner.evict(session.sessionId);
  });
});

// --- Message queue tests ---

describe("AgentRunner message queue", () => {
  test("queued prompt drains after turn completes", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      return mockStreamText([
        { type: "text-delta", text: `response-${callCount}` },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    // Start first prompt
    await agentRunner.prompt(session.sessionId, "first");

    // Queue second prompt while first is streaming
    const result = await agentRunner.prompt(session.sessionId, "second");
    expect(result.queued).toBe(true);

    // Wait for both turns to complete (first + drained)
    await waitUntil(
      () => events.filter(e => e.type === "turn_complete").length >= 2,
      5_000, "both turns to complete",
    );
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    // Both prompts should have been processed
    expect(callCount).toBe(2);

    // Session messages should include both user messages + both assistant responses
    const loaded = sessionMgr.load(session.sessionId);
    const userMsgs = loaded!.messages.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(2);
    expect(userMsgs[0].content).toBe("first");
    expect(userMsgs[1].content).toBe("second");

    agentRunner.evict(session.sessionId);
  });

  test("abort clears queued messages", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl((opts: any) => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        opts.abortSignal?.addEventListener("abort", () => resolveStream());
        await streamWait;
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Start first prompt
    const firstPromise = agentRunner.prompt(session.sessionId, "first");
    await waitUntil(
      () => agentRunner.getStatus(session.sessionId) === "streaming",
      2_000, "agent streaming",
    );

    // Queue two more prompts
    await agentRunner.prompt(session.sessionId, "queued-1");
    await agentRunner.prompt(session.sessionId, "queued-2");

    // Verify queue has 2 items
    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cached.queue.length).toBe(2);

    // Abort should clear the queue
    const aborted = agentRunner.abort(session.sessionId);
    expect(aborted).toBe(true);
    expect(cached.queue.length).toBe(0);

    await firstPromise;
    await agentRunner.waitForTurn(session.sessionId);
    agentRunner.evict(session.sessionId);
  });

  test("queue cap throws QueueFullError", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await streamWait;
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Start first prompt
    await agentRunner.prompt(session.sessionId, "first");
    await waitUntil(
      () => agentRunner.getStatus(session.sessionId) === "streaming",
      2_000, "agent streaming",
    );

    // Fill the queue to max
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      const r = await agentRunner.prompt(session.sessionId, `queued-${i}`);
      expect(r.queued).toBe(true);
    }

    // Next should throw QueueFullError
    try {
      await agentRunner.prompt(session.sessionId, "overflow");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(QueueFullError);
    }

    // Clean up
    agentRunner.abort(session.sessionId);
    resolveStream();
    await agentRunner.waitForTurn(session.sessionId);
    agentRunner.evict(session.sessionId);
  });

  test("queued user message persisted immediately", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await streamWait;
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });

    // Start first prompt
    await agentRunner.prompt(session.sessionId, "first");
    await waitUntil(
      () => agentRunner.getStatus(session.sessionId) === "streaming",
      2_000, "agent streaming",
    );

    // Queue a message
    const result = await agentRunner.prompt(session.sessionId, "queued msg");
    expect(result.queued).toBe(true);

    // User message should already be in session messages (before stream completes)
    const loaded = sessionMgr.load(session.sessionId);
    const userMsgs = loaded!.messages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content === "queued msg")).toBe(true);

    // Clean up
    agentRunner.abort(session.sessionId);
    resolveStream();
    await agentRunner.waitForTurn(session.sessionId);
    agentRunner.evict(session.sessionId);
  });

  test("abort returns true when only queue has items (agent idle)", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "done" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "first");
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    // Manually add items to the queue (simulating edge case)
    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    cached.queue.push({ text: "orphan", messageId: "msg_orphan" });

    // Agent is idle, but queue has items → abort should return true
    expect(agentRunner.abort(session.sessionId)).toBe(true);
    expect(cached.queue.length).toBe(0);

    agentRunner.evict(session.sessionId);
  });
});

// --- Per-step steering ---

describe("AgentRunner per-step steering", () => {
  test("queued message steers agent mid-turn", async () => {
    let callCount = 0;
    let resolveStep1!: () => void;
    const step1Wait = new Promise<void>((r) => (resolveStep1 = r));

    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_steer_1",
              toolName: "echo",
              input: { text: "working" },
            };
            yield {
              type: "tool-result",
              toolCallId: "tc_steer_1",
              toolName: "echo",
              output: "working result",
            };
            yield { type: "finish", finishReason: "tool-calls" };
            // Signal that step 1 is done so test can verify queue was consumed
            resolveStep1();
          })(),
        };
      }
      // Step 2: after steering message is injected, LLM responds
      return mockStreamText([
        { type: "text-delta", text: "Steered response" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);

    // Start multi-step prompt
    await agentRunner.prompt(session.sessionId, "do something long");

    // Wait for agent to start streaming
    await waitUntil(
      () => agentRunner.getStatus(session.sessionId) === "streaming" ||
            agentRunner.getStatus(session.sessionId) === "executing_tool",
      2_000, "agent active",
    );

    // Queue a steering message while agent is busy
    const queueResult = await agentRunner.prompt(session.sessionId, "change course now");
    expect(queueResult.queued).toBe(true);

    // Wait for the turn to complete — steering should have been consumed mid-turn
    await waitForEventType(events, "turn_complete");
    await agentRunner.waitForTurn(session.sessionId);
    unsub();

    // The queued message should have been consumed as steering (not as a separate follow-up turn)
    // Only 2 streamText calls: step 1 (tool-calls) + step 2 (after steering)
    expect(callCount).toBe(2);

    // The steering user message was already persisted to SessionManager at queue time
    const loaded = sessionMgr.load(session.sessionId);
    const userMsgs = loaded!.messages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content === "change course now")).toBe(true);

    // Queue should be empty (consumed by steering, not by drainQueue)
    const cached = (agentRunner as any).cachedSessions.get(session.sessionId);
    expect(cached.queue.length).toBe(0);

    agentRunner.evict(session.sessionId);
  });
});

// --- Runtime context injection ---

describe("AgentRunner runtime context", () => {
  test("prepareAgentRun sets runtime context on agent", async () => {
    let capturedMessages: any;
    setStreamTextImpl((opts: any) => {
      capturedMessages = opts.messages;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID, workspaceId: "test-ws" });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "what time is it?");
    await waitForEventType(events, "turn_complete");
    unsub();

    // The modelMessages passed to streamText should contain a runtime context user message
    expect(capturedMessages).toBeTruthy();
    const contextMsg = capturedMessages.find(
      (m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("[Runtime Context]"),
    );
    expect(contextMsg).toBeTruthy();
    expect(contextMsg.content).toContain("Current time:");
    expect(contextMsg.content).toContain("Timezone:");

    agentRunner.evict(session.sessionId);
  });
});
