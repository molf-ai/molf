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

describe("tool procedures", () => {
  test("tool.list nonexistent session", async () => {
    const caller = makeCaller();
    await expect(
      caller.tool.list({ sessionId: "nonexistent" }),
    ).rejects.toThrow("not found");
  });

  test("tool.list with valid session and connected worker", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "ToolWorker",
      connectedAt: Date.now(),
      tools: [{ name: "echo", description: "Echo tool", inputSchema: {} }],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    const result = await caller.tool.list({ sessionId: created.sessionId });
    expect(result.tools.length).toBe(1);
    expect(result.tools[0].name).toBe("echo");
    connectionRegistry.unregister(workerId);
  });

  test("tool.list with disconnected worker returns empty", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "TempWorker",
      connectedAt: Date.now(),
      tools: [{ name: "echo", description: "Echo", inputSchema: {} }],
      skills: [],
    });
    const caller = makeCaller();
    const created = await caller.session.create({ workerId, workspaceId: await getWsId(workerId) });
    connectionRegistry.unregister(workerId);
    const result = await caller.tool.list({ sessionId: created.sessionId });
    expect(result.tools).toEqual([]);
  });

  test("tool.approve with unknown approvalId returns applied=false", async () => {
    const caller = makeCaller();
    const result = await caller.tool.approve({ sessionId: "s1", approvalId: "nonexistent" });
    expect(result.applied).toBe(false);
  });

  test("tool.approve with always=true returns applied=false for unknown approvalId", async () => {
    const caller = makeCaller();
    const result = await caller.tool.approve({ sessionId: "s1", approvalId: "nonexistent", always: true });
    expect(result.applied).toBe(false);
  });

  test("tool.deny with unknown approvalId returns applied=false", async () => {
    const caller = makeCaller();
    const result = await caller.tool.deny({ sessionId: "s1", approvalId: "nonexistent" });
    expect(result.applied).toBe(false);
  });

  test("tool.deny with feedback returns applied=false for unknown approvalId", async () => {
    const caller = makeCaller();
    const result = await caller.tool.deny({
      sessionId: "s1",
      approvalId: "nonexistent",
      feedback: "Don't do that",
    });
    expect(result.applied).toBe(false);
  });
});
