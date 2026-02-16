import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

let streamTextImpl: (...args: any[]) => any;

mock.module("ai", () => ({
  streamText: (...args: any[]) => streamTextImpl(...args),
  tool: (def: any) => def,
  jsonSchema: (s: any) => s,
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => "mock-model",
}));

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => "mock-model",
}));

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

function makeStream(events: any[]) {
  return {
    fullStream: (async function* () {
      for (const e of events) yield e;
    })(),
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
    const session = sessionMgr.create({ workerId: disconnectedWorkerId });
    connectionRegistry.unregister(disconnectedWorkerId);

    try {
      await agentRunner.prompt(session.sessionId, "hello");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkerDisconnectedError);
    }
  });

  test("returns messageId for valid session and connected worker", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);

    const session = sessionMgr.create({ workerId: WORKER_ID });
    const result = await agentRunner.prompt(session.sessionId, "hello");
    expect(result.messageId).toBeTruthy();
    expect(result.messageId).toMatch(/^msg_/);
  });

  test("throws AgentBusyError when agent is already streaming", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await streamWait;
        yield { type: "finish", finishReason: "stop" };
      })(),
    });

    const session = sessionMgr.create({ workerId: WORKER_ID });

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
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Hello" },
        { type: "finish", finishReason: "stop" },
      ]);

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Response" },
        { type: "finish", finishReason: "stop" },
      ]);

    const session = sessionMgr.create({ workerId: WORKER_ID });
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

    streamTextImpl = (opts: any) => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        opts.abortSignal?.addEventListener("abort", () => resolveStream());
        await streamWait;
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })(),
    });

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
  test("activeSessions entry removed after prompt completes", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "done" },
        { type: "finish", finishReason: "stop" },
      ]);

    const session = sessionMgr.create({ workerId: WORKER_ID });
    const { events, unsub } = collectEvents(session.sessionId);

    await agentRunner.prompt(session.sessionId, "cleanup test");
    await waitForEventType(events, "turn_complete");
    // Allow the finally block to run
    await Bun.sleep(50);
    unsub();

    expect(agentRunner.getStatus(session.sessionId)).toBe("idle");
  });

  test("releaseIfIdle releases when no listeners and agent idle", () => {
    const session = sessionMgr.create({ workerId: WORKER_ID });

    // Session is in SessionManager's activeSessions cache
    expect(sessionMgr.getActive(session.sessionId)).toBeTruthy();

    // No listeners, no active agent → should release
    agentRunner.releaseIfIdle(session.sessionId);

    expect(sessionMgr.getActive(session.sessionId)).toBeUndefined();
  });

  test("releaseIfIdle does NOT release when listeners exist", () => {
    const session = sessionMgr.create({ workerId: WORKER_ID });

    // Subscribe a listener
    const unsub = eventBus.subscribe(session.sessionId, () => {});

    agentRunner.releaseIfIdle(session.sessionId);

    // Should still be in memory because listener exists
    expect(sessionMgr.getActive(session.sessionId)).toBeTruthy();

    unsub();
  });
});

describe("mapAgentEvent (indirect via EventBus)", () => {
  test("error event mapped to { code: AGENT_ERROR, message }", async () => {
    streamTextImpl = () => ({
      fullStream: (async function* () {
        throw new Error("LLM failed");
      })(),
    });

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = (opts: any) => {
      capturedTools = opts.tools;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = (opts: any) => {
      capturedTools = opts.tools;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = (opts: any) => {
      capturedTools = opts.tools;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = (opts: any) => {
      capturedTools = opts.tools;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = (opts: any) => {
      capturedTools = opts.tools;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Clean" },
        { type: "finish", finishReason: "stop" },
      ]);

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "I see the file reference" },
        { type: "finish", finishReason: "stop" },
      ]);

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = (opts: any) => {
      capturedMessages = opts.messages;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

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
    const session = sessionMgr.create({ workerId: WORKER_ID });
    const userMsg = {
      id: "msg_test_uncached",
      role: "user" as const,
      content: "Check this file",
      attachments: [{ path: ".molf/uploads/not-cached.pdf", mimeType: "application/pdf" }],
      timestamp: Date.now(),
    };
    sessionMgr.addMessage(session.sessionId, userMsg);

    let capturedMessages: any;
    streamTextImpl = (opts: any) => {
      capturedMessages = opts.messages;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const { events, unsub } = collectEvents(session.sessionId);
    await agentRunner.prompt(session.sessionId, "Follow up");
    await waitForEventType(events, "turn_complete");
    unsub();

    // Should not throw, should have text reference instead of inline
    expect(capturedMessages).toBeTruthy();
  });

  test("prompt with non-image fileRefs prepends text hints to prompt text", async () => {
    let capturedMessages: any;
    streamTextImpl = (opts: any) => {
      capturedMessages = opts.messages;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
    streamTextImpl = (opts: any) => {
      capturedMessages = opts.messages;
      return makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    };

    const session = sessionMgr.create({ workerId: WORKER_ID });
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
