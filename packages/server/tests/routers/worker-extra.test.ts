/**
 * Tests for worker router procedures with zero coverage:
 * - worker.syncState
 * - worker.uploadResult
 * Also tests tool.approve/deny with valid approvalIds (happy paths).
 */
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
import { createRouterClient } from "@orpc/server";
import type { ServerContext } from "../../src/context.js";
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

const WORKER_ID = crypto.randomUUID();

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
      workspaceNotifier: new WorkspaceNotifier(),
      providerState: makeProviderState(),
      dataDir: tmp.path,
    } as ServerContext,
  });
}

beforeAll(() => {
  tmp = createTmpDir("molf-worker-extra-");
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  toolDispatch = new ToolDispatch();
  uploadDispatch = new UploadDispatch(tmp.path);
  fsDispatch = new FsDispatch();
  inlineMediaCache = new InlineMediaCache();
  approvalGate = new ApprovalGate(new RulesetStorage(tmp.path), eventBus);
  workspaceStore = new WorkspaceStore(tmp.path);
  agentRunner = new AgentRunner(
    sessionMgr, eventBus, connectionRegistry, toolDispatch,
    makeProviderState(), "gemini/test", inlineMediaCache, approvalGate, workspaceStore,
  );

  // Register a worker for tests
  connectionRegistry.registerWorker({
    id: WORKER_ID,
    name: "test-worker",
    connectedAt: Date.now(),
    tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object" } }],
    skills: [],
    agents: [],
  });
});

afterAll(() => {
  connectionRegistry.unregister(WORKER_ID);
  inlineMediaCache.close();
  tmp.cleanup();
});

describe("worker.syncState", () => {
  test("updates worker tools and skills", async () => {
    const caller = makeCaller();
    const result = await caller.worker.syncState({
      workerId: WORKER_ID,
      tools: [
        { name: "echo", description: "Echo updated", inputSchema: { type: "object" } },
        { name: "read_file", description: "Read file", inputSchema: { type: "object" } },
      ],
      skills: [{ name: "deploy", description: "Deploy", content: "instructions" }],
    });

    expect(result.synced).toBe(true);

    const worker = connectionRegistry.getWorker(WORKER_ID)!;
    expect(worker.tools).toHaveLength(2);
    expect(worker.skills).toHaveLength(1);
  });

  test("updates with agents field", async () => {
    const caller = makeCaller();
    const result = await caller.worker.syncState({
      workerId: WORKER_ID,
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      skills: [],
      agents: [{ name: "coder", description: "A coding agent", content: "You are a coding agent." }],
    });

    expect(result.synced).toBe(true);
    const worker = connectionRegistry.getWorker(WORKER_ID)!;
    expect(worker.agents).toHaveLength(1);
    expect(worker.agents![0].name).toBe("coder");
  });

  test("throws NOT_FOUND for unknown worker", async () => {
    const caller = makeCaller();
    await expect(
      caller.worker.syncState({
        workerId: crypto.randomUUID(),
        tools: [],
      }),
    ).rejects.toThrow("not found");
  });
});

describe("worker.uploadResult", () => {
  test("resolves a pending upload", async () => {
    const caller = makeCaller();

    // Dispatch an upload first (simulating agent.upload)
    const uploadPromise = uploadDispatch.dispatch(WORKER_ID, {
      uploadId: "up-1",
      data: "base64data",
      filename: "test.txt",
      mimeType: "text/plain",
    });

    // Worker responds with result
    const result = await caller.worker.uploadResult({
      uploadId: "up-1",
      path: "/workspace/.molf/uploads/test.txt",
      size: 10,
    });

    expect(result.received).toBe(true);

    const uploadResult = await uploadPromise;
    expect(uploadResult.path).toBe("/workspace/.molf/uploads/test.txt");
  });

  test("resolves with error", async () => {
    const caller = makeCaller();

    const uploadPromise = uploadDispatch.dispatch(WORKER_ID, {
      uploadId: "up-2",
      data: "base64data",
      filename: "fail.txt",
      mimeType: "text/plain",
    });

    await caller.worker.uploadResult({
      uploadId: "up-2",
      path: "",
      size: 0,
      error: "disk full",
    });

    const uploadResult = await uploadPromise;
    expect(uploadResult.error).toBe("disk full");
  });
});

describe("tool.approve with valid approvalId", () => {
  test("approve once resolves pending approval", async () => {
    const caller = makeCaller();
    const sessionId = "approve-test-session";

    // Create a pending approval
    const evalResult = await approvalGate.evaluate(
      "shell_exec", { command: "python test.py" }, sessionId, WORKER_ID,
    );
    expect(evalResult.action).toBe("ask");

    const approvalId = approvalGate.requestApproval(
      "shell_exec", { command: "python test.py" },
      evalResult.patterns, evalResult.alwaysPatterns, sessionId, WORKER_ID,
    );
    const waitPromise = approvalGate.waitForApproval(approvalId);

    // Approve via router
    const result = await caller.tool.approve({ sessionId, approvalId, always: false });
    expect(result.applied).toBe(true);

    // Promise should resolve
    await waitPromise;
    expect(approvalGate.pendingCount).toBe(0);
  });

  test("approve always resolves and adds runtime rule", async () => {
    const caller = makeCaller();
    const sessionId = "approve-always-session";

    const evalResult = await approvalGate.evaluate(
      "shell_exec", { command: "curl https://example.com" }, sessionId, WORKER_ID,
    );
    const approvalId = approvalGate.requestApproval(
      "shell_exec", { command: "curl https://example.com" },
      evalResult.patterns, evalResult.alwaysPatterns, sessionId, WORKER_ID,
    );
    const waitPromise = approvalGate.waitForApproval(approvalId);

    const result = await caller.tool.approve({ sessionId, approvalId, always: true });
    expect(result.applied).toBe(true);
    await waitPromise;

    // Future curl commands should auto-allow
    const r2 = await approvalGate.evaluate(
      "shell_exec", { command: "curl https://other.com" }, sessionId, WORKER_ID,
    );
    expect(r2.action).toBe("allow");
  });
});

describe("tool.deny with valid approvalId", () => {
  test("deny rejects pending approval", async () => {
    const caller = makeCaller();
    const sessionId = "deny-test-session";

    const evalResult = await approvalGate.evaluate(
      "shell_exec", { command: "rm -rf /tmp" }, sessionId, WORKER_ID,
    );
    const approvalId = approvalGate.requestApproval(
      "shell_exec", { command: "rm -rf /tmp" },
      evalResult.patterns, evalResult.alwaysPatterns, sessionId, WORKER_ID,
    );
    const waitPromise = approvalGate.waitForApproval(approvalId);
    waitPromise.catch(() => {}); // suppress unhandled rejection

    const result = await caller.tool.deny({ sessionId, approvalId });
    expect(result.applied).toBe(true);

    await expect(waitPromise).rejects.toThrow("rejected");
  });

  test("deny with feedback includes it in error", async () => {
    const caller = makeCaller();
    const sessionId = "deny-feedback-session";

    const evalResult = await approvalGate.evaluate(
      "shell_exec", { command: "deploy prod" }, sessionId, WORKER_ID,
    );
    const approvalId = approvalGate.requestApproval(
      "shell_exec", { command: "deploy prod" },
      evalResult.patterns, evalResult.alwaysPatterns, sessionId, WORKER_ID,
    );
    const waitPromise = approvalGate.waitForApproval(approvalId);
    waitPromise.catch(() => {});

    const result = await caller.tool.deny({ sessionId, approvalId, feedback: "Not now" });
    expect(result.applied).toBe(true);

    await expect(waitPromise).rejects.toThrow("Not now");
  });
});
