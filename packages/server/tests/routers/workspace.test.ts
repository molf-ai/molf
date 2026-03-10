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
import { WorkspaceStore } from "../../src/workspace-store.js";
import { WorkspaceNotifier } from "../../src/workspace-notifier.js";
import { ApprovalGate } from "../../src/approval/approval-gate.js";
import { RulesetStorage } from "../../src/approval/ruleset-storage.js";
import { appRouter } from "../../src/router.js";
import { initTRPC } from "@trpc/server";
import type { ServerContext } from "../../src/context.js";
import { makeProviderState } from "../_provider-state.js";

const t = initTRPC.context<ServerContext>().create();
const createCallerFactory = t.createCallerFactory;

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

const WORKER_ID = "ws-router-test-worker";

function makeCaller(token: string | null = "valid-token") {
  const createCaller = createCallerFactory(appRouter);
  return createCaller({
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
  });
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
  agentRunner = new AgentRunner(
    sessionMgr, eventBus, connectionRegistry, toolDispatch,
    makeProviderState(), "gemini/test", inlineMediaCache, approvalGate,
    workspaceStore,
  );
});

afterAll(() => {
  inlineMediaCache.close();
  tmp.cleanup();
});

describe("workspace router", () => {
  describe("ensureDefault", () => {
    test("creates default workspace with initial session", async () => {
      const caller = makeCaller();
      const result = await caller.workspace.ensureDefault({ workerId: WORKER_ID });
      expect(result.workspace.name).toBe("main");
      expect(result.workspace.isDefault).toBe(true);
      expect(result.sessionId).toBeTruthy();
      expect(result.workspace.sessions).toContain(result.sessionId);
    });

    test("returns existing default on second call", async () => {
      const caller = makeCaller();
      const first = await caller.workspace.ensureDefault({ workerId: WORKER_ID });
      const second = await caller.workspace.ensureDefault({ workerId: WORKER_ID });
      expect(second.workspace.id).toBe(first.workspace.id);
      expect(second.sessionId).toBe(first.sessionId);
    });
  });

  describe("create", () => {
    test("creates workspace with first session", async () => {
      const caller = makeCaller();
      const result = await caller.workspace.create({
        workerId: WORKER_ID,
        name: "router-create-test",
      });
      expect(result.workspace.name).toBe("router-create-test");
      expect(result.workspace.isDefault).toBe(false);
      expect(result.sessionId).toBeTruthy();
      expect(result.workspace.sessions).toContain(result.sessionId);
    });

    test("creates workspace with config", async () => {
      const caller = makeCaller();
      const result = await caller.workspace.create({
        workerId: WORKER_ID,
        name: "router-config-test",
        config: { model: "gemini-pro" },
      });
      expect(result.workspace.config.model).toBe("gemini-pro");
    });

    test("rejects duplicate workspace name", async () => {
      const caller = makeCaller();
      await caller.workspace.create({ workerId: WORKER_ID, name: "router-dup-test" });
      await expect(
        caller.workspace.create({ workerId: WORKER_ID, name: "router-dup-test" }),
      ).rejects.toThrow("already exists");
    });
  });

  describe("list", () => {
    test("returns all workspaces for worker", async () => {
      const caller = makeCaller();
      const list = await caller.workspace.list({ workerId: WORKER_ID });
      expect(list.length).toBeGreaterThanOrEqual(1);
      const names = list.map((w) => w.name);
      expect(names).toContain("main");
    });

    test("returns empty for unknown worker", async () => {
      const caller = makeCaller();
      const list = await caller.workspace.list({ workerId: "unknown-worker-xyz" });
      expect(list).toEqual([]);
    });
  });

  describe("rename", () => {
    test("renames a workspace", async () => {
      const caller = makeCaller();
      const { workspace } = await caller.workspace.create({
        workerId: WORKER_ID,
        name: "router-rename-before",
      });
      const result = await caller.workspace.rename({
        workerId: WORKER_ID,
        workspaceId: workspace.id,
        name: "router-rename-after",
      });
      expect(result.success).toBe(true);

      // Verify via list
      const list = await caller.workspace.list({ workerId: WORKER_ID });
      const renamed = list.find((w) => w.id === workspace.id);
      expect(renamed?.name).toBe("router-rename-after");
    });

    test("throws NOT_FOUND for unknown workspace", async () => {
      const caller = makeCaller();
      await expect(
        caller.workspace.rename({
          workerId: WORKER_ID,
          workspaceId: "nonexistent-ws-id",
          name: "whatever",
        }),
      ).rejects.toThrow("not found");
    });
  });

  describe("setConfig", () => {
    test("updates workspace config and emits event", async () => {
      const caller = makeCaller();
      const { workspace } = await caller.workspace.create({
        workerId: WORKER_ID,
        name: "router-setconfig-test",
      });

      // Subscribe to events before changing config
      const events: any[] = [];
      const unsub = workspaceNotifier.subscribe(WORKER_ID, workspace.id, (event) => {
        events.push(event);
      });

      const result = await caller.workspace.setConfig({
        workerId: WORKER_ID,
        workspaceId: workspace.id,
        config: { model: "gemini-flash" },
      });
      expect(result.success).toBe(true);

      // Verify event emitted
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("config_changed");
      expect(events[0].config.model).toBe("gemini-flash");

      unsub();

      // Verify via list
      const list = await caller.workspace.list({ workerId: WORKER_ID });
      const updated = list.find((w) => w.id === workspace.id);
      expect(updated?.config.model).toBe("gemini-flash");
    });
  });

  describe("sessions", () => {
    test("returns sessions scoped to workspace", async () => {
      const caller = makeCaller();
      const ws1 = await caller.workspace.create({
        workerId: WORKER_ID,
        name: "router-sessions-a",
      });
      const ws2 = await caller.workspace.create({
        workerId: WORKER_ID,
        name: "router-sessions-b",
      });

      const sessions1 = await caller.workspace.sessions({
        workerId: WORKER_ID,
        workspaceId: ws1.workspace.id,
      });
      const sessions2 = await caller.workspace.sessions({
        workerId: WORKER_ID,
        workspaceId: ws2.workspace.id,
      });

      // Each workspace should have exactly 1 session (auto-created)
      expect(sessions1.length).toBe(1);
      expect(sessions2.length).toBe(1);
      expect(sessions1[0].sessionId).toBe(ws1.sessionId);
      expect(sessions2[0].sessionId).toBe(ws2.sessionId);
    });

    test("lastSessionId is pinned first in session list", async () => {
      const caller = makeCaller();
      const ws = await caller.workspace.create({
        workerId: WORKER_ID,
        name: "router-sessions-order",
      });

      // Create additional session in the workspace
      const s2 = await sessionMgr.create({
        workerId: WORKER_ID,
        workspaceId: ws.workspace.id,
      });
      await workspaceStore.addSession(WORKER_ID, ws.workspace.id, s2.sessionId);

      const sessions = await caller.workspace.sessions({
        workerId: WORKER_ID,
        workspaceId: ws.workspace.id,
      });

      expect(sessions.length).toBe(2);
      // lastSessionId (s2) should be first
      expect(sessions[0].isLastSession).toBe(true);
      expect(sessions[0].sessionId).toBe(s2.sessionId);
    });

    test("throws NOT_FOUND for unknown workspace", async () => {
      const caller = makeCaller();
      await expect(
        caller.workspace.sessions({
          workerId: WORKER_ID,
          workspaceId: "nonexistent-ws-id",
        }),
      ).rejects.toThrow("not found");
    });
  });

  describe("ensureDefault self-repair", () => {
    test("creates new session if lastSessionId is broken", async () => {
      const caller = makeCaller();
      // Use a different worker to isolate this test
      const workerId = "self-repair-worker";
      const first = await caller.workspace.ensureDefault({ workerId });

      // Delete the session file to simulate broken lastSessionId
      sessionMgr.delete(first.sessionId);

      const repaired = await caller.workspace.ensureDefault({ workerId });
      expect(repaired.workspace.id).toBe(first.workspace.id);
      // Should have created a new session
      expect(repaired.sessionId).not.toBe(first.sessionId);
    });
  });
});
