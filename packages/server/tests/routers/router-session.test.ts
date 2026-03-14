import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { SessionManager } from "../../src/session-mgr.js";
import { ConnectionRegistry } from "../../src/connection-registry.js";
import { EventBus } from "../../src/event-bus.js";
import { ToolDispatch } from "../../src/tool-dispatch.js";
import { UploadDispatch } from "../../src/upload-dispatch.js";
import { FsDispatch } from "../../src/fs-dispatch.js";
import { InlineMediaCache } from "../../src/inline-media-cache.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { appRouter } from "../../src/router.js";
import { createRouterClient } from "@orpc/server";
import type { ServerContext } from "../../src/context.js";
import { ApprovalGate } from "../../src/approval/approval-gate.js";
import { RulesetStorage } from "../../src/approval/ruleset-storage.js";
import { WorkspaceStore } from "../../src/workspace-store.js";
import { WorkspaceNotifier } from "../../src/workspace-notifier.js";
import { makeProviderState } from "../_provider-state.js";

let tmp: TmpDir;
let sessionMgr: SessionManager;
let connectionRegistry: ConnectionRegistry;
let eventBus: EventBus;
let toolDispatch: ToolDispatch;
let uploadDispatch: UploadDispatch;
let fsDispatch: FsDispatch;
let inlineMediaCache: InlineMediaCache;
let agentRunner: AgentRunner;
let approvalGate: ApprovalGate;
let workspaceStore: WorkspaceStore;
let workspaceNotifier: WorkspaceNotifier;

function makeCaller(token: string | null = "valid-token") {
  return createRouterClient(appRouter, {
    context: {
      token,
      clientId: "test-client",
      sessionMgr,
      connectionRegistry,
      agentRunner,
      eventBus,
      toolDispatch,
      uploadDispatch,
      fsDispatch,
      inlineMediaCache,
      approvalGate,
      workspaceStore,
      workspaceNotifier,
      providerState: makeProviderState(),
      dataDir: tmp.path,
    } as ServerContext,
  });
}

async function getWsId(workerId: string): Promise<string> {
  return (await workspaceStore.ensureDefault(workerId)).id;
}

beforeAll(() => {
  tmp = createTmpDir();
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  toolDispatch = new ToolDispatch();
  uploadDispatch = new UploadDispatch();
  fsDispatch = new FsDispatch();
  inlineMediaCache = new InlineMediaCache();
  approvalGate = new ApprovalGate(new RulesetStorage(tmp.path), eventBus);
  workspaceStore = new WorkspaceStore(tmp.path);
  workspaceNotifier = new WorkspaceNotifier();
  agentRunner = new AgentRunner(sessionMgr, eventBus, connectionRegistry, toolDispatch, makeProviderState(), "gemini/test", inlineMediaCache, approvalGate, workspaceStore);
});

afterAll(() => {
  inlineMediaCache.close();
  tmp.cleanup();
});

describe("auth middleware", () => {
  test("authed procedure with valid token", async () => {
    const caller = makeCaller("valid-token");
    const result = await caller.session.list();
    expect(result.sessions).toBeDefined();
  });

  test("authed procedure with null token", async () => {
    const caller = makeCaller(null);
    await expect(caller.session.list()).rejects.toThrow("Missing authentication token");
  });
});

describe("session procedures", () => {
  test("session.create with valid worker", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "Worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const result = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    expect(result.sessionId).toBeTruthy();
    expect(result.workerId).toBe(workerId);
    connectionRegistry.unregister(workerId);
  });

  test("session.create with nonexistent worker", async () => {
    const caller = makeCaller();
    await expect(
      caller.session.create({ workerId: "550e8400-e29b-41d4-a716-446655440000", workspaceId: await getWsId("550e8400-e29b-41d4-a716-446655440000") }),
    ).rejects.toThrow("not found");
  });

  test("session.list", async () => {
    const caller = makeCaller();
    const result = await caller.session.list();
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  test("session.load nonexistent", async () => {
    const caller = makeCaller();
    await expect(
      caller.session.load({ sessionId: "nonexistent" }),
    ).rejects.toThrow("not found");
  });

  test("session.load success", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "Worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    const loaded = await caller.session.load({ sessionId: created.sessionId });
    expect(loaded.sessionId).toBe(created.sessionId);
    expect(loaded.workerId).toBe(workerId);
    expect(Array.isArray(loaded.messages)).toBe(true);
    connectionRegistry.unregister(workerId);
  });

  test("session.delete existing", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "Worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    const result = await caller.session.delete({ sessionId: created.sessionId });
    expect(result.deleted).toBe(true);
    connectionRegistry.unregister(workerId);
  });

  test("session.delete nonexistent returns deleted=false", async () => {
    const caller = makeCaller();
    const result = await caller.session.delete({ sessionId: "nonexistent" });
    expect(result.deleted).toBe(false);
  });

  test("session.rename nonexistent", async () => {
    const caller = makeCaller();
    await expect(
      caller.session.rename({ sessionId: "nonexistent", name: "New" }),
    ).rejects.toThrow("not found");
  });

  test("session.rename success", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "Worker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    const result = await caller.session.rename({ sessionId: created.sessionId, name: "Renamed" });
    expect(result.renamed).toBe(true);
    const loaded = await caller.session.load({ sessionId: created.sessionId });
    expect(loaded.name).toBe("Renamed");
    connectionRegistry.unregister(workerId);
  });
});

describe("session.list with workerId filter", () => {
  test("returns only sessions for the specified worker", async () => {
    const workerIdA = crypto.randomUUID();
    const workerIdB = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerIdA,
      name: "WorkerA",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    connectionRegistry.registerWorker({
      id: workerIdB,
      name: "WorkerB",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await caller.session.create({ workerId: workerIdA, workspaceId: await getWsId(workerIdA) });
    await caller.session.create({ workerId: workerIdA, workspaceId: await getWsId(workerIdA) });
    await caller.session.create({ workerId: workerIdB, workspaceId: await getWsId(workerIdB) });

    const filteredA = await caller.session.list({ workerId: workerIdA });
    expect(filteredA.sessions.length).toBe(2);
    expect(filteredA.sessions.every((s) => s.workerId === workerIdA)).toBe(true);

    const filteredB = await caller.session.list({ workerId: workerIdB });
    expect(filteredB.sessions.length).toBe(1);
    expect(filteredB.sessions[0].workerId).toBe(workerIdB);

    connectionRegistry.unregister(workerIdA);
    connectionRegistry.unregister(workerIdB);
  });

  test("returns all sessions when no workerId filter", async () => {
    const caller = makeCaller();
    const result = await caller.session.list();
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  test("returns all sessions when undefined input", async () => {
    const caller = makeCaller();
    const result = await caller.session.list(undefined);
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  test("limit restricts returned sessions", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "LimitWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    const result = await caller.session.list({ workerId, limit: 2 });
    expect(result.sessions.length).toBe(2);
    expect(result.total).toBe(3);

    connectionRegistry.unregister(workerId);
  });

  test("offset skips sessions", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "OffsetWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    const all = await caller.session.list({ workerId });
    const result = await caller.session.list({ workerId, offset: 1 });
    expect(result.total).toBe(3);
    expect(result.sessions.length).toBe(2);
    expect(result.sessions[0].sessionId).toBe(all.sessions[1].sessionId);

    connectionRegistry.unregister(workerId);
  });

  test("returns only sessions matching metadata filter", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "MetaWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId), metadata: { client: "telegram", chatId: 100 } });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId), metadata: { client: "telegram", chatId: 200 } });
    await caller.session.create({ workerId, workspaceId: await getWsId(workerId), metadata: { client: "tui" } });

    const filtered = await caller.session.list({ metadata: { client: "telegram" } });
    expect(filtered.sessions.length).toBe(2);
    expect(filtered.sessions.every((s) => s.metadata?.client === "telegram")).toBe(true);

    connectionRegistry.unregister(workerId);
  });
});

describe("session.list active flag", () => {
  test("active reflects EventBus listeners, not just cache", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "ActiveFlagWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    // No listeners, agent idle → should be inactive
    const list1 = await caller.session.list();
    const item1 = list1.sessions.find((s) => s.sessionId === created.sessionId);
    expect(item1!.active).toBe(false);

    // Subscribe a listener → should be active
    const unsub = eventBus.subscribe(created.sessionId, () => {});
    const list2 = await caller.session.list();
    const item2 = list2.sessions.find((s) => s.sessionId === created.sessionId);
    expect(item2!.active).toBe(true);

    unsub();
    connectionRegistry.unregister(workerId);
  });
});
