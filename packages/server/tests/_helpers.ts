/**
 * Shared test infrastructure for server package tests.
 */

export { setStreamTextImpl, setGenerateTextImpl, aiMockFactory } from "@molf-ai/test-utils/ai-mock-harness";

import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { flushAsync } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

export { makeProviderState } from "./_provider-state.js";
import { makeProviderState } from "./_provider-state.js";

import { SessionManager } from "../src/session-mgr.js";
import { ConnectionRegistry, type WorkerRegistration } from "../src/connection-registry.js";
import { ServerBus } from "../src/server-bus.js";
import { ToolDispatch } from "../src/tool-dispatch.js";
import { InlineMediaCache } from "../src/inline-media-cache.js";
import { ApprovalGate } from "../src/approval/approval-gate.js";
import { RulesetStorage } from "../src/approval/ruleset-storage.js";
import { AgentRunner } from "../src/agent-runner.js";
import { WorkspaceStore } from "../src/workspace-store.js";
import { ServerState } from "../src/server-state.js";

export {
  SessionManager, ConnectionRegistry, ServerBus, ToolDispatch,
  InlineMediaCache, ApprovalGate, RulesetStorage, AgentRunner, WorkspaceStore,
  ServerState,
  type WorkerRegistration,
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function makeWorker(overrides?: Partial<WorkerRegistration>): WorkerRegistration {
  return {
    role: "worker",
    id: "w1",
    name: "test-worker",
    connectedAt: Date.now(),
    tools: [],
    skills: [],
    agents: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

export function collectEvents(
  serverBus: InstanceType<typeof ServerBus>,
  sessionId: string,
): { events: AgentEvent[]; unsub: () => void } {
  const events: AgentEvent[] = [];
  const unsub = serverBus.subscribe({ type: "session", sessionId }, (event) => events.push(event));
  return { events, unsub };
}

export function waitForEventType(
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
        return reject(
          new Error(`Timed out waiting for "${type}" (got: ${events.map((e) => e.type).join(", ")})`),
        );
      }
      setTimeout(check, 20);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Full test harness factory
// ---------------------------------------------------------------------------

export interface TestHarness {
  tmp: TmpDir;
  env: EnvGuard;
  sessionMgr: InstanceType<typeof SessionManager>;
  connectionRegistry: InstanceType<typeof ConnectionRegistry>;
  serverBus: InstanceType<typeof ServerBus>;
  toolDispatch: InstanceType<typeof ToolDispatch>;
  inlineMediaCache: InstanceType<typeof InlineMediaCache>;
  approvalGate: InstanceType<typeof ApprovalGate>;
  agentRunner: InstanceType<typeof AgentRunner>;
  workerId: string;
  cleanup: () => Promise<void>;
}

export function createTestHarness(opts?: {
  contextWindow?: number;
  workerOverrides?: Partial<WorkerRegistration>;
  tmpPrefix?: string;
  hookRegistry?: import("@molf-ai/protocol").HookRegistry;
}): TestHarness {
  const env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");

  const tmp = createTmpDir(opts?.tmpPrefix ?? "molf-test-");
  const sessionMgr = new SessionManager(tmp.path);
  const connectionRegistry = new ConnectionRegistry();
  const serverBus = new ServerBus();
  const toolDispatch = new ToolDispatch();
  const inlineMediaCache = new InlineMediaCache();
  const rulesetStorage = new RulesetStorage(tmp.path);
  const approvalGate = new ApprovalGate(rulesetStorage, serverBus);
  const workerId = crypto.randomUUID();

  const workspaceStore = new WorkspaceStore(tmp.path);
  const pluginLoaderLike = opts?.hookRegistry ? {
    hookRegistry: opts.hookRegistry,
    hookLogger: { warn: () => {} },
    pluginTools: [],
    sessionToolFactories: [],
  } : undefined;
  const serverState = new ServerState({
    providerState: makeProviderState(opts?.contextWindow),
    defaultModel: "gemini/test",
    configPath: "",
  });
  const agentRunner = new AgentRunner(
    sessionMgr, serverBus, connectionRegistry, toolDispatch,
    serverState,
    inlineMediaCache, approvalGate, workspaceStore,
    pluginLoaderLike as any,
  );

  connectionRegistry.registerWorker({
    id: workerId,
    name: "test-worker",
    connectedAt: Date.now(),
    tools: [{
      name: "echo",
      description: "Echo the input",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }],
    skills: [],
    agents: [],
    ...opts?.workerOverrides,
  });

  return {
    tmp, env, sessionMgr, connectionRegistry, serverBus,
    toolDispatch, inlineMediaCache, approvalGate, agentRunner, workerId,
    cleanup: async () => {
      connectionRegistry.unregister(workerId);
      inlineMediaCache.close();
      await flushAsync();
      tmp.cleanup();
      env.restore();
    },
  };
}
