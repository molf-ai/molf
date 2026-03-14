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

describe("fs.read", () => {
  test("session not found → NOT_FOUND", async () => {
    const caller = makeCaller();
    await expect(
      caller.fs.read({ sessionId: "nonexistent", outputId: "out1" }),
    ).rejects.toThrow("Session nonexistent not found");
  });

  test("worker not connected → PRECONDITION_FAILED", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "TempWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    connectionRegistry.unregister(workerId);

    await expect(
      caller.fs.read({ sessionId: created.sessionId, outputId: "out1" }),
    ).rejects.toThrow("Worker not connected");
  });

  test("happy path: dispatches to worker and returns content", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "FsWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    // Set up worker subscription to auto-resolve fs reads
    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of fsDispatch.subscribeWorker(workerId, ac.signal)) {
        fsDispatch.resolveRead(req.requestId, {
          requestId: req.requestId,
          content: "full file content here",
          size: 22,
          encoding: "utf-8",
        });
      }
    })();

    const result = await caller.fs.read({
      sessionId: created.sessionId,
      outputId: "out_test",
    });

    expect(result.content).toBe("full file content here");
    expect(result.size).toBe(22);
    expect(result.encoding).toBe("utf-8");

    ac.abort();
    await sub;
    connectionRegistry.unregister(workerId);
  });

  test("worker returns error → INTERNAL_SERVER_ERROR", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "FsErrorWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of fsDispatch.subscribeWorker(workerId, ac.signal)) {
        fsDispatch.resolveRead(req.requestId, {
          requestId: req.requestId,
          content: "",
          size: 0,
          encoding: "utf-8",
          error: "File not found",
        });
      }
    })();

    await expect(
      caller.fs.read({ sessionId: created.sessionId, outputId: "missing" }),
    ).rejects.toThrow("File not found");

    ac.abort();
    await sub;
    connectionRegistry.unregister(workerId);
  });

  test("worker disconnect during read → PRECONDITION_FAILED", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "FsDisconnectWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });

    const ac = new AbortController();
    const sub = (async () => {
      for await (const req of fsDispatch.subscribeWorker(workerId, ac.signal)) {
        fsDispatch.resolveRead(req.requestId, {
          requestId: req.requestId,
          content: "",
          size: 0,
          encoding: "utf-8",
          error: `Worker ${workerId} disconnected`,
        });
      }
    })();

    await expect(
      caller.fs.read({ sessionId: created.sessionId, outputId: "out1" }),
    ).rejects.toThrow("disconnected");

    ac.abort();
    await sub;
    connectionRegistry.unregister(workerId);
  });
});
