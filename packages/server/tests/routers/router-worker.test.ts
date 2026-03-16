import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { SessionManager } from "../../src/session-mgr.js";
import { ConnectionRegistry } from "../../src/connection-registry.js";
import { ServerBus } from "../../src/server-bus.js";
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
import { ServerState } from "../../src/server-state.js";
import { ServerBus } from "../../src/server-bus.js";
import { ProviderKeyStore } from "../../src/provider-keys.js";
import { makeProviderState } from "../_provider-state.js";

let tmp: TmpDir;
let sessionMgr: SessionManager;
let connectionRegistry: ConnectionRegistry;
let serverBus: ServerBus;
let toolDispatch: ToolDispatch;
let uploadDispatch: UploadDispatch;
let fsDispatch: FsDispatch;
let inlineMediaCache: InlineMediaCache;
let agentRunner: AgentRunner;
let approvalGate: ApprovalGate;
let workspaceStore: WorkspaceStore;

function makeCaller(token: string | null = "valid-token") {
  return createRouterClient(appRouter, {
    context: {
      token,
      clientId: "test-client",
      sessionMgr,
      connectionRegistry,
      agentRunner,
      serverBus,
      toolDispatch,
      uploadDispatch,
      fsDispatch,
      inlineMediaCache,
      approvalGate,
      workspaceStore,
      serverState: new ServerState({ providerState: makeProviderState(), defaultModel: "gemini/test", configPath: "" }),
      providerKeyStore: new ProviderKeyStore(tmp.path),
      dataDir: tmp.path,
    } as ServerContext,
  });
}

beforeAll(() => {
  tmp = createTmpDir();
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  serverBus = new ServerBus();
  toolDispatch = new ToolDispatch();
  uploadDispatch = new UploadDispatch(tmp.path);
  fsDispatch = new FsDispatch();
  inlineMediaCache = new InlineMediaCache();
  approvalGate = new ApprovalGate(new RulesetStorage(tmp.path), serverBus);
  workspaceStore = new WorkspaceStore(tmp.path);
  agentRunner = new AgentRunner(sessionMgr, serverBus, connectionRegistry, toolDispatch, new ServerState({ providerState: makeProviderState(), defaultModel: "gemini/test", configPath: "" }), inlineMediaCache, approvalGate, workspaceStore);
});

afterAll(() => {
  inlineMediaCache.close();
  tmp.cleanup();
});

describe("worker procedures", () => {
  test("worker.register", async () => {
    const caller = makeCaller();
    const workerId = crypto.randomUUID();
    const result = await caller.worker.register({
      workerId,
      name: "TestWorker",
      tools: [],
    });
    expect(result.workerId).toBe(workerId);
    expect(connectionRegistry.isConnected(workerId)).toBe(true);
    connectionRegistry.unregister(workerId);
  });

  test("worker.register duplicate replaces stale connection", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "W",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    // Re-registration should succeed (stale cleanup)
    const result = await caller.worker.register({ workerId, name: "W2", tools: [] });
    expect(result.workerId).toBe(workerId);
    // New registration should have the updated name
    const worker = connectionRegistry.getWorker(workerId);
    expect(worker?.name).toBe("W2");
    connectionRegistry.unregister(workerId);
  });

  test("worker.rename nonexistent", async () => {
    const caller = makeCaller();
    await expect(
      caller.worker.rename({
        workerId: "550e8400-e29b-41d4-a716-446655440000",
        name: "New",
      }),
    ).rejects.toThrow("not found");
  });

  test("worker.rename success", async () => {
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "OldName",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const caller = makeCaller();
    const result = await caller.worker.rename({ workerId, name: "NewName" });
    expect(result.renamed).toBe(true);
    const worker = connectionRegistry.getWorker(workerId);
    expect(worker!.name).toBe("NewName");
    connectionRegistry.unregister(workerId);
  });

  test("worker.toolResult", async () => {
    const caller = makeCaller();
    const result = await caller.worker.toolResult({
      toolCallId: "tc_unknown",
      output: "value",
    });
    expect(result.received).toBe(false);
  });

  test("worker.toolResult with truncation fields", async () => {
    const caller = makeCaller();
    // Set up a pending dispatch so resolveToolCall returns true
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "TruncWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    const dispatchPromise = toolDispatch.dispatch(workerId, {
      toolCallId: "tc_trunc_1",
      toolName: "echo",
      args: {},
    });

    const result = await caller.worker.toolResult({
      toolCallId: "tc_trunc_1",
      output: "truncated content",
      meta: { truncated: true, outputId: "tc_trunc_1" },
    });
    expect(result.received).toBe(true);

    const dispatchResult = await dispatchPromise;
    expect(dispatchResult.meta?.truncated).toBe(true);
    expect(dispatchResult.meta?.outputId).toBe("tc_trunc_1");

    connectionRegistry.unregister(workerId);
  });

  test("worker.fsReadResult resolves a pending fs read", async () => {
    const caller = makeCaller();
    const workerId = crypto.randomUUID();
    connectionRegistry.registerWorker({
      id: workerId,
      name: "FsWorker",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });

    const dispatchPromise = fsDispatch.dispatch(workerId, {
      requestId: "fs_test_1",
      outputId: "out_1",
    });

    const result = await caller.worker.fsReadResult({
      requestId: "fs_test_1",
      content: "file content here",
      size: 17,
      encoding: "utf-8",
    });
    expect(result.received).toBe(true);

    const fsResult = await dispatchPromise;
    expect(fsResult.content).toBe("file content here");
    expect(fsResult.size).toBe(17);
    expect(fsResult.encoding).toBe("utf-8");

    connectionRegistry.unregister(workerId);
  });
});
