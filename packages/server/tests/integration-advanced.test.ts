import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter, AgentEvent } from "@molf-ai/protocol";
import { startServer } from "../src/server.js";
import type { ServerInstance } from "../src/server.js";

let testDir: string;
let server: ServerInstance;
let trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
let wsClient: ReturnType<typeof createWSClient>;

const TEST_PORT = 17602;

// Deterministic UUIDs for test workers
const WORKER_ALPHA = "a0000000-0000-4000-a000-000000000001";
const WORKER_BETA = "a0000000-0000-4000-a000-000000000002";
const WORKER_DISPATCH = "a0000000-0000-4000-a000-000000000003";
const WORKER_QUEUE = "a0000000-0000-4000-a000-000000000004";
const WORKER_EVENTS = "a0000000-0000-4000-a000-000000000005";
const WORKER_DISCONNECT = "a0000000-0000-4000-a000-000000000006";
const WORKER_STATUS = "a0000000-0000-4000-a000-000000000007";
const WORKER_EDGE = "a0000000-0000-4000-a000-000000000008";
const WORKER_META = "a0000000-0000-4000-a000-000000000009";
const WORKER_RENAME_NF = "a0000000-0000-4000-a000-00000000000a";
const WORKER_TOOLLIST_DC = "a0000000-0000-4000-a000-00000000000b";
const WORKER_PERSIST = "a0000000-0000-4000-a000-00000000000c";

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "molf-integration-adv-"));
  process.env.MOLF_TOKEN = "test-advanced-token";

  server = startServer({
    host: "127.0.0.1",
    port: TEST_PORT,
    dataDir: testDir,
  });

  await new Promise((resolve) => setTimeout(resolve, 200));

  const url = new URL(`ws://127.0.0.1:${TEST_PORT}`);
  url.searchParams.set("token", server.token);
  url.searchParams.set("name", "test-client-adv");

  wsClient = createWSClient({ url: url.toString() });
  trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });
});

afterAll(() => {
  wsClient?.close();
  server?.close();
  delete process.env.MOLF_TOKEN;
  rmSync(testDir, { recursive: true, force: true });
});

// --- Authentication ---

describe("Integration: Authentication failure", () => {
  test("unauthenticated client gets rejected on procedure calls", async () => {
    const noAuthClient = createWSClient({
      url: `ws://127.0.0.1:${TEST_PORT}`,
    });
    const noAuthTrpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: noAuthClient })],
    });

    try {
      await noAuthTrpc.session.list.query();
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("authentication");
    } finally {
      noAuthClient.close();
    }
  });

  test("invalid token gets rejected", async () => {
    const url = new URL(`ws://127.0.0.1:${TEST_PORT}`);
    url.searchParams.set("token", "wrong-token-value");

    const badAuthClient = createWSClient({ url: url.toString() });
    const badAuthTrpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: badAuthClient })],
    });

    try {
      await badAuthTrpc.session.list.query();
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("authentication");
    } finally {
      badAuthClient.close();
    }
  });

  test("unauthenticated client cannot register a worker", async () => {
    const noAuthClient = createWSClient({
      url: `ws://127.0.0.1:${TEST_PORT}`,
    });
    const noAuthTrpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: noAuthClient })],
    });

    try {
      await noAuthTrpc.worker.register.mutate({
        workerId: "00000000-0000-4000-a000-ffffffffffff",
        name: "bad",
        tools: [],
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("authentication");
    } finally {
      noAuthClient.close();
    }
  });

  test("unauthenticated client cannot create a session", async () => {
    const noAuthClient = createWSClient({
      url: `ws://127.0.0.1:${TEST_PORT}`,
    });
    const noAuthTrpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: noAuthClient })],
    });

    try {
      await noAuthTrpc.session.create.mutate({
        workerId: "00000000-0000-4000-a000-ffffffffffff",
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("authentication");
    } finally {
      noAuthClient.close();
    }
  });
});

// --- Multi-worker routing ---

describe("Integration: Multi-worker routing", () => {
  test("register two workers with different tools", async () => {
    await trpc.worker.register.mutate({
      workerId: WORKER_ALPHA,
      name: "worker-alpha",
      tools: [
        {
          name: "read_file",
          description: "Reads files",
          inputSchema: { type: "object" },
        },
      ],
      skills: [
        { name: "coding", description: "Write code", content: "Code skill" },
      ],
    });

    await trpc.worker.register.mutate({
      workerId: WORKER_BETA,
      name: "worker-beta",
      tools: [
        {
          name: "run_shell",
          description: "Runs shell commands",
          inputSchema: { type: "object" },
        },
        {
          name: "write_file",
          description: "Writes files",
          inputSchema: { type: "object" },
        },
      ],
    });

    const result = await trpc.agent.list.query();
    expect(result.workers.length).toBeGreaterThanOrEqual(2);

    const alpha = result.workers.find((w) => w.workerId === WORKER_ALPHA);
    const beta = result.workers.find((w) => w.workerId === WORKER_BETA);
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha!.tools).toHaveLength(1);
    expect(beta!.tools).toHaveLength(2);
    expect(alpha!.skills).toHaveLength(1);
    expect(beta!.skills ?? []).toHaveLength(0);
  });

  test("sessions are bound to their specific worker", async () => {
    const s1 = await trpc.session.create.mutate({
      workerId: WORKER_ALPHA,
      name: "Alpha Session",
    });
    const s2 = await trpc.session.create.mutate({
      workerId: WORKER_BETA,
      name: "Beta Session",
    });

    const loaded1 = await trpc.session.load.mutate({
      sessionId: s1.sessionId,
    });
    const loaded2 = await trpc.session.load.mutate({
      sessionId: s2.sessionId,
    });

    expect(loaded1.workerId).toBe(WORKER_ALPHA);
    expect(loaded2.workerId).toBe(WORKER_BETA);
  });

  test("tool.list returns tools for the correct worker per session", async () => {
    const s1 = await trpc.session.create.mutate({ workerId: WORKER_ALPHA });
    const s2 = await trpc.session.create.mutate({ workerId: WORKER_BETA });

    const tools1 = await trpc.tool.list.query({ sessionId: s1.sessionId });
    const tools2 = await trpc.tool.list.query({ sessionId: s2.sessionId });

    expect(tools1.tools).toHaveLength(1);
    expect(tools1.tools[0].name).toBe("read_file");
    expect(tools1.tools[0].workerId).toBe(WORKER_ALPHA);

    expect(tools2.tools).toHaveLength(2);
    const tool2Names = tools2.tools.map((t) => t.name).sort();
    expect(tool2Names).toEqual(["run_shell", "write_file"]);
    expect(tools2.tools[0].workerId).toBe(WORKER_BETA);
  });

  test("agent.list shows skills only for worker that has them", async () => {
    const result = await trpc.agent.list.query();
    const alpha = result.workers.find((w) => w.workerId === WORKER_ALPHA);
    const beta = result.workers.find((w) => w.workerId === WORKER_BETA);

    expect(alpha!.skills[0].name).toBe("coding");
    expect(alpha!.skills[0].content).toBe("Code skill");
    expect(beta!.skills).toHaveLength(0);
  });
});

// --- Tool dispatch full round-trip ---

describe("Integration: Tool dispatch full round-trip", () => {
  test("worker receives dispatched tool call and sends result", async () => {
    await trpc.worker.register.mutate({
      workerId: WORKER_DISPATCH,
      name: "roundtrip-worker",
      tools: [
        {
          name: "calculate",
          description: "Calculates",
          inputSchema: { type: "object" },
        },
      ],
    });

    const received: any[] = [];
    const subscription = trpc.worker.onToolCall.subscribe(
      { workerId: WORKER_DISPATCH },
      {
        onData: async (data) => {
          received.push(data);
          await trpc.worker.toolResult.mutate({
            toolCallId: data.toolCallId,
            result: {
              answer: (data.args as any).a + (data.args as any).b,
            },
          });
        },
        onError: () => {},
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Dispatch via internal API (simulates what AgentRunner does)
    const result = await server._ctx.toolDispatch.dispatch(WORKER_DISPATCH, {
      toolCallId: "tc_rt_1",
      toolName: "calculate",
      args: { a: 20, b: 22 },
    });

    expect(result.result).toEqual({ answer: 42 });
    expect(result.error).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0].toolName).toBe("calculate");
    expect(received[0].args).toEqual({ a: 20, b: 22 });

    subscription.unsubscribe();
  });

  test("tool dispatch with error result", async () => {
    const received: any[] = [];
    const subscription = trpc.worker.onToolCall.subscribe(
      { workerId: WORKER_DISPATCH },
      {
        onData: async (data) => {
          received.push(data);
          await trpc.worker.toolResult.mutate({
            toolCallId: data.toolCallId,
            error: "Tool execution failed: file not found",
          });
        },
        onError: () => {},
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    const result = await server._ctx.toolDispatch.dispatch(WORKER_DISPATCH, {
      toolCallId: "tc_rt_err",
      toolName: "calculate",
      args: {},
    });

    expect(result.error).toBe("Tool execution failed: file not found");
    expect(received).toHaveLength(1);

    subscription.unsubscribe();
  });

  test("multiple sequential tool dispatches", async () => {
    const received: any[] = [];
    const subscription = trpc.worker.onToolCall.subscribe(
      { workerId: WORKER_DISPATCH },
      {
        onData: async (data) => {
          received.push(data);
          await trpc.worker.toolResult.mutate({
            toolCallId: data.toolCallId,
            result: { echo: data.args },
          });
        },
        onError: () => {},
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    const r1 = await server._ctx.toolDispatch.dispatch(WORKER_DISPATCH, {
      toolCallId: "tc_seq_1",
      toolName: "calculate",
      args: { n: 1 },
    });
    const r2 = await server._ctx.toolDispatch.dispatch(WORKER_DISPATCH, {
      toolCallId: "tc_seq_2",
      toolName: "calculate",
      args: { n: 2 },
    });
    const r3 = await server._ctx.toolDispatch.dispatch(WORKER_DISPATCH, {
      toolCallId: "tc_seq_3",
      toolName: "calculate",
      args: { n: 3 },
    });

    expect(r1.result).toEqual({ echo: { n: 1 } });
    expect(r2.result).toEqual({ echo: { n: 2 } });
    expect(r3.result).toEqual({ echo: { n: 3 } });
    expect(received).toHaveLength(3);

    subscription.unsubscribe();
  });

  test("tool call queued before worker subscribes is delivered", async () => {
    await trpc.worker.register.mutate({
      workerId: WORKER_QUEUE,
      name: "queue-worker",
      tools: [
        {
          name: "queued_tool",
          description: "Queued",
          inputSchema: { type: "object" },
        },
      ],
    });

    // Dispatch BEFORE subscribing — will be queued
    const resultPromise = server._ctx.toolDispatch.dispatch(WORKER_QUEUE, {
      toolCallId: "tc_queued_1",
      toolName: "queued_tool",
      args: { queued: true },
    });

    // Now subscribe — should drain the queue
    const received: any[] = [];
    const subscription = trpc.worker.onToolCall.subscribe(
      { workerId: WORKER_QUEUE },
      {
        onData: async (data) => {
          received.push(data);
          await trpc.worker.toolResult.mutate({
            toolCallId: data.toolCallId,
            result: { drained: true },
          });
        },
        onError: () => {},
      },
    );

    const result = await resultPromise;
    expect(result.result).toEqual({ drained: true });
    expect(received).toHaveLength(1);
    expect(received[0].args).toEqual({ queued: true });

    subscription.unsubscribe();
  });

  test("toolResult for unknown toolCallId returns received: false", async () => {
    const result = await trpc.worker.toolResult.mutate({
      toolCallId: "nonexistent-tool-call",
      result: { data: "whatever" },
    });

    expect(result.received).toBe(false);
  });
});

// --- Event streaming ---

describe("Integration: Event streaming via onEvents", () => {
  beforeAll(async () => {
    await trpc.worker.register.mutate({
      workerId: WORKER_EVENTS,
      name: "events-worker",
      tools: [],
    });
  });

  test("events are delivered in order to subscriber", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_EVENTS,
      name: "Events Test",
    });

    const received: AgentEvent[] = [];
    const subscription = trpc.agent.onEvents.subscribe(
      { sessionId: session.sessionId },
      {
        onData: (event) => received.push(event),
        onError: () => {},
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Emit events through event bus
    const eventBus = server._ctx.eventBus;
    eventBus.emit(session.sessionId, {
      type: "status_change",
      status: "streaming",
    });
    eventBus.emit(session.sessionId, {
      type: "content_delta",
      delta: "Hello",
      content: "Hello",
    });
    eventBus.emit(session.sessionId, {
      type: "content_delta",
      delta: " world",
      content: "Hello world",
    });
    eventBus.emit(session.sessionId, {
      type: "turn_complete",
      message: {
        id: "m1",
        role: "assistant",
        content: "Hello world",
        timestamp: Date.now(),
      },
    });
    eventBus.emit(session.sessionId, {
      type: "status_change",
      status: "idle",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received).toHaveLength(5);
    expect(received[0].type).toBe("status_change");
    expect((received[0] as any).status).toBe("streaming");
    expect(received[1].type).toBe("content_delta");
    expect((received[1] as any).delta).toBe("Hello");
    expect(received[2].type).toBe("content_delta");
    expect((received[2] as any).content).toBe("Hello world");
    expect(received[3].type).toBe("turn_complete");
    expect((received[3] as any).message.content).toBe("Hello world");
    expect(received[4].type).toBe("status_change");
    expect((received[4] as any).status).toBe("idle");

    subscription.unsubscribe();
  });

  test("multiple subscribers receive the same events", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_EVENTS,
      name: "Multi-Sub Test",
    });

    const received1: AgentEvent[] = [];
    const received2: AgentEvent[] = [];

    const sub1 = trpc.agent.onEvents.subscribe(
      { sessionId: session.sessionId },
      {
        onData: (event) => received1.push(event),
        onError: () => {},
      },
    );
    const sub2 = trpc.agent.onEvents.subscribe(
      { sessionId: session.sessionId },
      {
        onData: (event) => received2.push(event),
        onError: () => {},
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    const eventBus = server._ctx.eventBus;
    eventBus.emit(session.sessionId, {
      type: "status_change",
      status: "streaming",
    });
    eventBus.emit(session.sessionId, {
      type: "error",
      code: "TEST_ERROR",
      message: "Test error",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received1).toHaveLength(2);
    expect(received2).toHaveLength(2);
    expect(received1[0].type).toBe("status_change");
    expect(received2[0].type).toBe("status_change");
    expect(received1[1].type).toBe("error");
    expect(received2[1].type).toBe("error");

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("events for different sessions are isolated", async () => {
    const s1 = await trpc.session.create.mutate({
      workerId: WORKER_EVENTS,
      name: "Isolation A",
    });
    const s2 = await trpc.session.create.mutate({
      workerId: WORKER_EVENTS,
      name: "Isolation B",
    });

    const received1: AgentEvent[] = [];
    const received2: AgentEvent[] = [];

    const sub1 = trpc.agent.onEvents.subscribe(
      { sessionId: s1.sessionId },
      {
        onData: (event) => received1.push(event),
        onError: () => {},
      },
    );
    const sub2 = trpc.agent.onEvents.subscribe(
      { sessionId: s2.sessionId },
      {
        onData: (event) => received2.push(event),
        onError: () => {},
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    const eventBus = server._ctx.eventBus;
    eventBus.emit(s1.sessionId, {
      type: "status_change",
      status: "streaming",
    });
    eventBus.emit(s2.sessionId, {
      type: "content_delta",
      delta: "Only for s2",
      content: "Only for s2",
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received1).toHaveLength(1);
    expect(received1[0].type).toBe("status_change");
    expect(received2).toHaveLength(1);
    expect(received2[0].type).toBe("content_delta");

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("error event propagates through subscription", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_EVENTS,
      name: "Error Propagation",
    });

    const received: AgentEvent[] = [];
    const subscription = trpc.agent.onEvents.subscribe(
      { sessionId: session.sessionId },
      {
        onData: (event) => received.push(event),
        onError: () => {},
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    const eventBus = server._ctx.eventBus;
    eventBus.emit(session.sessionId, {
      type: "error",
      code: "AGENT_ERROR",
      message: "LLM provider returned error",
      context: { sessionId: session.sessionId },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("error");
    expect((received[0] as any).code).toBe("AGENT_ERROR");
    expect((received[0] as any).message).toBe("LLM provider returned error");

    subscription.unsubscribe();
  });
});

// --- Agent prompt error paths ---

describe("Integration: Agent prompt error paths", () => {
  test("agent.prompt rejects for nonexistent session", async () => {
    try {
      await trpc.agent.prompt.mutate({
        sessionId: "nonexistent-session-id",
        text: "Hello",
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("not found");
    }
  });

  test("agent.prompt rejects when worker is disconnected", async () => {
    // Register worker
    await trpc.worker.register.mutate({
      workerId: WORKER_DISCONNECT,
      name: "will-disconnect",
      tools: [],
    });

    // Create session bound to this worker
    const session = await trpc.session.create.mutate({
      workerId: WORKER_DISCONNECT,
    });

    // Simulate worker disconnect by unregistering from connection registry
    server._ctx.connectionRegistry.unregister(WORKER_DISCONNECT);

    try {
      await trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Hello",
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("disconnected");
    }
  });

  test("session.create rejects for unregistered worker", async () => {
    try {
      await trpc.session.create.mutate({
        workerId: "00000000-0000-4000-a000-fffffffffffe",
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("not found");
    }
  });
});

// --- Agent status and abort ---

describe("Integration: Agent status and abort", () => {
  beforeAll(async () => {
    if (!server._ctx.connectionRegistry.isConnected(WORKER_STATUS)) {
      await trpc.worker.register.mutate({
        workerId: WORKER_STATUS,
        name: "status-worker",
        tools: [],
      });
    }
  });

  test("agent.status returns idle for session with no active prompt", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_STATUS,
    });

    const status = await trpc.agent.status.query({
      sessionId: session.sessionId,
    });

    expect(status.status).toBe("idle");
    expect(status.sessionId).toBe(session.sessionId);
  });

  test("agent.abort returns false for non-active session", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_STATUS,
    });

    const result = await trpc.agent.abort.mutate({
      sessionId: session.sessionId,
    });

    expect(result.aborted).toBe(false);
  });

  test("agent.status returns idle for unknown session", async () => {
    const status = await trpc.agent.status.query({
      sessionId: "unknown-session",
    });

    expect(status.status).toBe("idle");
  });
});

// --- Session edge cases ---

describe("Integration: Session edge cases", () => {
  beforeAll(async () => {
    if (!server._ctx.connectionRegistry.isConnected(WORKER_EDGE)) {
      await trpc.worker.register.mutate({
        workerId: WORKER_EDGE,
        name: "session-edge-worker",
        tools: [],
      });
    }
  });

  test("deleting already-deleted session returns deleted: false", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_EDGE,
      name: "Delete Twice",
    });

    const first = await trpc.session.delete.mutate({
      sessionId: session.sessionId,
    });
    expect(first.deleted).toBe(true);

    const second = await trpc.session.delete.mutate({
      sessionId: session.sessionId,
    });
    expect(second.deleted).toBe(false);
  });

  test("session list shows correct message count after adding messages", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_EDGE,
      name: "Message Count",
    });

    server._ctx.sessionMgr.addMessage(session.sessionId, {
      id: "msg_1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });
    server._ctx.sessionMgr.addMessage(session.sessionId, {
      id: "msg_2",
      role: "assistant",
      content: "Hi there",
      timestamp: Date.now(),
    });
    server._ctx.sessionMgr.save(session.sessionId);

    const list = await trpc.session.list.query();
    const found = list.sessions.find(
      (s) => s.sessionId === session.sessionId,
    );
    expect(found).toBeDefined();
    expect(found!.messageCount).toBe(2);
  });

  test("loaded session contains persisted messages", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_EDGE,
      name: "Persisted Messages",
    });

    server._ctx.sessionMgr.addMessage(session.sessionId, {
      id: "msg_p1",
      role: "user",
      content: "First message",
      timestamp: Date.now(),
    });
    server._ctx.sessionMgr.addMessage(session.sessionId, {
      id: "msg_p2",
      role: "assistant",
      content: "Response",
      timestamp: Date.now(),
    });
    server._ctx.sessionMgr.save(session.sessionId);

    const loaded = await trpc.session.load.mutate({
      sessionId: session.sessionId,
    });

    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].role).toBe("user");
    expect(loaded.messages[0].content).toBe("First message");
    expect(loaded.messages[1].role).toBe("assistant");
    expect(loaded.messages[1].content).toBe("Response");
  });

  test("session.create with custom name and config", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_EDGE,
      name: "Custom Config Session",
      config: {
        llm: { model: "test-model" },
        behavior: { maxIterations: 5 },
      },
    });

    expect(session.name).toBe("Custom Config Session");
    expect(session.workerId).toBe(WORKER_EDGE);
    expect(session.createdAt).toBeGreaterThan(0);
  });

  test("tool.list for nonexistent session returns NOT_FOUND", async () => {
    try {
      await trpc.tool.list.query({ sessionId: "no-such-session" });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("not found");
    }
  });
});

// --- Worker lifecycle ---

describe("Integration: Worker lifecycle", () => {
  test("worker registration includes metadata", async () => {
    await trpc.worker.register.mutate({
      workerId: WORKER_META,
      name: "metadata-worker",
      tools: [],
      metadata: { workdir: "/home/user/project", version: "1.0.0" },
    });

    const worker = server._ctx.connectionRegistry.getWorker(WORKER_META);
    expect(worker).toBeDefined();
    expect(worker!.metadata).toEqual({
      workdir: "/home/user/project",
      version: "1.0.0",
    });
  });

  test("renaming nonexistent worker returns NOT_FOUND", async () => {
    try {
      await trpc.worker.rename.mutate({
        workerId: WORKER_RENAME_NF,
        name: "new-name",
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("not found");
    }
  });

  test("tool.list returns empty when session's worker is disconnected", async () => {
    await trpc.worker.register.mutate({
      workerId: WORKER_TOOLLIST_DC,
      name: "temp",
      tools: [
        {
          name: "temp_tool",
          description: "Temporary",
          inputSchema: { type: "object" },
        },
      ],
    });

    const session = await trpc.session.create.mutate({
      workerId: WORKER_TOOLLIST_DC,
    });

    // Disconnect worker
    server._ctx.connectionRegistry.unregister(WORKER_TOOLLIST_DC);

    const result = await trpc.tool.list.query({
      sessionId: session.sessionId,
    });
    expect(result.tools).toHaveLength(0);
  });
});

// --- Session persistence across restart ---

describe("Integration: Full session persistence", () => {
  beforeAll(async () => {
    if (!server._ctx.connectionRegistry.isConnected(WORKER_PERSIST)) {
      await trpc.worker.register.mutate({
        workerId: WORKER_PERSIST,
        name: "persist-worker",
        tools: [],
      });
    }
  });

  test("session with messages persists and loads from new SessionManager", async () => {
    const session = await trpc.session.create.mutate({
      workerId: WORKER_PERSIST,
      name: "Full Persist Test",
    });

    server._ctx.sessionMgr.addMessage(session.sessionId, {
      id: "fp_1",
      role: "user",
      content: "Question",
      timestamp: Date.now(),
    });
    server._ctx.sessionMgr.addMessage(session.sessionId, {
      id: "fp_2",
      role: "assistant",
      content: "Answer",
      timestamp: Date.now(),
    });
    server._ctx.sessionMgr.save(session.sessionId);

    const { SessionManager } = await import("../src/session-mgr.js");
    const freshMgr = new SessionManager(testDir);
    const loaded = freshMgr.load(session.sessionId);

    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("Full Persist Test");
    expect(loaded!.workerId).toBe(WORKER_PERSIST);
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].content).toBe("Question");
    expect(loaded!.messages[1].content).toBe("Answer");
  });

  test("session list from fresh manager includes all sessions", async () => {
    await trpc.session.create.mutate({
      workerId: WORKER_PERSIST,
      name: "Persist A",
    });
    await trpc.session.create.mutate({
      workerId: WORKER_PERSIST,
      name: "Persist B",
    });

    const { SessionManager } = await import("../src/session-mgr.js");
    const freshMgr = new SessionManager(testDir);
    const list = freshMgr.list();

    const names = list.map((s) => s.name);
    expect(names).toContain("Persist A");
    expect(names).toContain("Persist B");
  });
});
