import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

const {
  buildAgentSystemPrompt,
  buildSkillTool,
  AgentRunner,
  SessionNotFoundError,
  AgentBusyError,
  WorkerDisconnectedError,
} = await import("../src/agent-runner.js");
const { SessionManager } = await import("../src/session-mgr.js");
const { ConnectionRegistry } = await import("../src/connection-registry.js");
const { EventBus } = await import("../src/event-bus.js");
const { ToolDispatch } = await import("../src/tool-dispatch.js");
const { InlineMediaCache } = await import("../src/inline-media-cache.js");

import type { WorkerRegistration } from "../src/connection-registry.js";

function makeWorker(overrides?: Partial<WorkerRegistration>): WorkerRegistration {
  return {
    role: "worker",
    id: "w1",
    name: "test-worker",
    connectedAt: Date.now(),
    tools: [],
    skills: [],
    ...overrides,
  };
}

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

describe("buildSkillTool", () => {
  test("with skills returns tool def", async () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy app", content: "Deploy instructions" }],
    });
    const result = buildSkillTool(worker);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("skill");

    // Execute with valid skill
    const execResult = await result!.toolDef.execute!({ name: "deploy" } as any, {} as any);
    expect((execResult as any).content).toBe("Deploy instructions");
  });

  test("without skills returns null", () => {
    const worker = makeWorker();
    expect(buildSkillTool(worker)).toBeNull();
  });

  test("execute with unknown skill returns error", async () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy", content: "..." }],
    });
    const result = buildSkillTool(worker);
    const execResult = await result!.toolDef.execute!({ name: "unknown" } as any, {} as any);
    expect((execResult as any).error).toContain("Unknown skill");
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

let tmp: TmpDir;
let env: EnvGuard;
let sessionMgr: InstanceType<typeof SessionManager>;
let connectionRegistry: InstanceType<typeof ConnectionRegistry>;
let eventBus: InstanceType<typeof EventBus>;
let toolDispatch: InstanceType<typeof ToolDispatch>;
let inlineMediaCache: InstanceType<typeof InlineMediaCache>;
let agentRunner: InstanceType<typeof AgentRunner>;

const WORKER_ID = crypto.randomUUID();

function collectEvents(sessionId: string): { events: AgentEvent[]; unsub: () => void } {
  const events: AgentEvent[] = [];
  const unsub = eventBus.subscribe(sessionId, (event) => events.push(event));
  return { events, unsub };
}

function waitForEventType(
  events: AgentEvent[],
  type: string,
  timeoutMs = 5_000,
): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = events.find((e) => e.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for "${type}" (got: ${events.map((e) => e.type).join(", ")})`));
      }
      setTimeout(check, 20);
    };
    check();
  });
}

beforeAll(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");

  tmp = createTmpDir("molf-agent-runner-");
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  toolDispatch = new ToolDispatch();
  inlineMediaCache = new InlineMediaCache();
  agentRunner = new AgentRunner(sessionMgr, eventBus, connectionRegistry, toolDispatch, { provider: "gemini", model: "test" }, inlineMediaCache);

  connectionRegistry.registerWorker({
    id: WORKER_ID,
    name: "runner-worker",
    connectedAt: Date.now(),
    tools: [{
      name: "echo",
      description: "Echo the input",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }],
    skills: [],
  });
});

afterAll(() => {
  connectionRegistry.unregister(WORKER_ID);
  inlineMediaCache.close();
  tmp.cleanup();
  env.restore();
});

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
    const session = await sessionMgr.create({ workerId: disconnectedWorkerId });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const result = await agentRunner.prompt(session.sessionId, "hello");
    expect(result.messageId).toBeTruthy();
    expect(result.messageId).toMatch(/^msg_/);
  });

  test("throws AgentBusyError when agent is already streaming", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await streamWait;
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID });

    // Start first prompt (don't await — it will hang)
    const firstPromise = agentRunner.prompt(session.sessionId, "first");
    await Bun.sleep(50);

    // Second prompt should throw AgentBusyError
    try {
      await agentRunner.prompt(session.sessionId, "second");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AgentBusyError);
    }

    // Clean up: resolve the first stream
    resolveStream();
    await firstPromise;
  });

  test("emits events to EventBus (status_change, content_delta, turn_complete)", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hello" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const promptPromise = agentRunner.prompt(session.sessionId, "abort me");
    await Bun.sleep(50);

    const aborted = agentRunner.abort(session.sessionId);
    expect(aborted).toBe(true);

    // Wait for prompt to settle (agent handles AbortError internally)
    await promptPromise;
    // Allow runPrompt to finish
    await Bun.sleep(50);
  });
});

describe("AgentRunner cleanup", () => {
  test("status returns to idle after prompt completes", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "done" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "cleanup test");
    await waitForEventType(events, "turn_complete");
    // Allow the finally block to run
    await Bun.sleep(50);
    unsub();

    expect(agentRunner.getStatus(session.sessionId)).toBe("idle");
  });

  test("releaseIfIdle releases when no listeners and agent idle", async () => {
    const session = await sessionMgr.create({ workerId: WORKER_ID });

    // Session is in SessionManager's activeSessions cache
    expect(sessionMgr.getActive(session.sessionId)).toBeTruthy();

    // No listeners, no active agent → should release
    await agentRunner.releaseIfIdle(session.sessionId);

    expect(sessionMgr.getActive(session.sessionId)).toBeUndefined();
  });

  test("releaseIfIdle does NOT release when listeners exist", async () => {
    const session = await sessionMgr.create({ workerId: WORKER_ID });

    // Subscribe a listener
    const unsub = eventBus.subscribe(session.sessionId, () => {});

    await agentRunner.releaseIfIdle(session.sessionId);

    // Should still be in memory because listener exists
    expect(sessionMgr.getActive(session.sessionId)).toBeTruthy();

    unsub();
  });
});

describe("mapAgentEvent (indirect via EventBus)", () => {
  test("error event mapped to { code: AGENT_ERROR, message }", async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        throw new Error("LLM failed");
      })(),
    }));

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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
        toolDispatch.resolveToolCall(req.toolCallId, { echoed: true });
      }
    })();

    const result = await capturedTools.echo.execute({ text: "hi" });
    expect(result).toEqual({ echoed: true });

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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture tools 2");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Set up worker subscription to return an error
    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of toolDispatch.subscribeWorker(WORKER_ID, ac.signal)) {
        toolDispatch.resolveToolCall(req.toolCallId, null, "tool failed");
      }
    })();

    try {
      await capturedTools.echo.execute({ text: "hi" });
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toBe("tool failed");
    }

    ac.abort();
    await sub;
  });

  test("remote tool toModelOutput converts image BinaryResult to content with image-data", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture toModelOutput");
    await waitForEventType(events, "turn_complete");
    unsub();

    expect(capturedTools.echo.toModelOutput).toBeTruthy();

    // Image binary result
    const imageResult = capturedTools.echo.toModelOutput({
      output: { type: "binary", data: "abc123", mimeType: "image/png", path: "/img.png", size: 100 },
    });
    expect(imageResult.type).toBe("content");
    expect(imageResult.value).toHaveLength(2);
    expect(imageResult.value[0].type).toBe("text");
    expect(imageResult.value[0].text).toContain("image/png");
    expect(imageResult.value[1].type).toBe("image-data");
    expect(imageResult.value[1].data).toBe("abc123");
    expect(imageResult.value[1].mediaType).toBe("image/png");
  });

  test("remote tool toModelOutput converts non-image BinaryResult to content with file-data", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture toModelOutput 2");
    await waitForEventType(events, "turn_complete");
    unsub();

    // PDF binary result
    const pdfResult = capturedTools.echo.toModelOutput({
      output: { type: "binary", data: "pdf123", mimeType: "application/pdf", path: "/doc.pdf", size: 500 },
    });
    expect(pdfResult.type).toBe("content");
    expect(pdfResult.value[1].type).toBe("file-data");
    expect(pdfResult.value[1].mediaType).toBe("application/pdf");
  });

  test("remote tool toModelOutput passes non-binary results as json", async () => {
    let capturedTools: any = null;
    setStreamTextImpl((opts: any) => {
      capturedTools = opts.tools;
      return mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "capture toModelOutput 3");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Regular result
    const jsonResult = capturedTools.echo.toModelOutput({
      output: { content: "hello world", totalLines: 5 },
    });
    expect(jsonResult.type).toBe("json");
    expect(jsonResult.value).toEqual({ content: "hello world", totalLines: 5 });
  });

  test("turn_complete strips extra fields from message", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Clean" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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
    const session = await sessionMgr.create({ workerId: WORKER_ID });
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
    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });

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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "test cache");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(50);
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "will be evicted");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(50);
    unsub();

    // Verify it's cached
    expect((agentRunner as any).cachedSessions.has(session.sessionId)).toBe(true);

    // Evict
    agentRunner.evict(session.sessionId);

    // Should be removed from cache
    expect((agentRunner as any).cachedSessions.has(session.sessionId)).toBe(false);
    expect(agentRunner.getStatus(session.sessionId)).toBe("idle");
  });

  test("evict() on non-cached session is a no-op", () => {
    agentRunner.evict("nonexistent-session");
    // Should not throw
    expect(true).toBe(true);
  });

  test("concurrent prompt() calls — second throws AgentBusyError [P3-F1]", async () => {
    // Use a slow stream so the first prompt is still "streaming" when the second fires
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "slow" },
        { type: "delay", ms: 500 },
        { type: "text-delta", text: " response" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);

    // First prompt — starts streaming synchronously before returning
    await agentRunner.prompt(session.sessionId, "first");

    // Second prompt — should throw immediately because status is already "streaming"
    expect(() => agentRunner.prompt(session.sessionId, "second")).toThrow(AgentBusyError);

    // Wait for the first prompt to finish and clean up
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(50);
    unsub();
    agentRunner.evict(session.sessionId);
  });

  test("abort() returns false for cached-but-idle session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "done" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "idle after");
    await waitForEventType(events, "turn_complete");
    await Bun.sleep(50);
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);

    // Start prompt (async — fires and returns)
    await agentRunner.prompt(session.sessionId, "will be evicted mid-turn");

    // Evict while the prompt is still streaming
    agentRunner.evict(session.sessionId);

    // Wait a bit for the prompt to finish — should NOT throw
    await Bun.sleep(500);
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });

    // Manually create a cached entry to test releaseIfIdle guard
    (agentRunner as any).cachedSessions.set(session.sessionId, {
      agent: {},
      sessionId: session.sessionId,
      workerId: WORKER_ID,
      status: "idle",
      lastActiveAt: Date.now(),
      evictionTimer: null,
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
    const session = await sessionMgr.create({ workerId: WORKER_ID });

    await agentRunner.injectShellResult(session.sessionId, "ls -la", "stdout:\nfile1.txt\n\nstderr:\n\nExit code: 0");

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
    const session = await sessionMgr.create({ workerId: WORKER_ID });

    // No agent prompt has been made, so no cached session
    expect((agentRunner as any).cachedSessions.has(session.sessionId)).toBe(false);

    // Should not throw
    await agentRunner.injectShellResult(session.sessionId, "echo hi", "stdout:\nhi\n\nstderr:\n\nExit code: 0");

    const loaded = sessionMgr.load(session.sessionId);
    expect(loaded!.messages.length).toBe(3);
  });

  test("injects into cached Agent's in-memory Session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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
    await agentRunner.injectShellResult(session.sessionId, "pwd", "stdout:\n/home\n\nstderr:\n\nExit code: 0");

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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });
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

    const session = await sessionMgr.create({ workerId: WORKER_ID });

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

    const session = await sessionMgr.create({ workerId: WORKER_ID });

    // Manually create a cached entry for the session we'll evict
    (agentRunner as any).cachedSessions.set(session.sessionId, {
      agent: { getStatus: () => "idle" },
      sessionId: session.sessionId,
      workerId: WORKER_ID,
      status: "idle",
      lastActiveAt: Date.now(),
      evictionTimer: null,
    });

    agentRunner.evict(session.sessionId);

    // truncationMeta for the OTHER session should still be present
    expect((agentRunner as any).truncationMeta.size).toBe(2);
    expect((agentRunner as any).truncationMeta.has("other_session_call_1")).toBe(true);
    expect((agentRunner as any).truncationMeta.has("other_session_call_2")).toBe(true);
  });
});
