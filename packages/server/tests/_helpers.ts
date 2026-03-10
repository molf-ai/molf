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
import { EventBus } from "../src/event-bus.js";
import { ToolDispatch } from "../src/tool-dispatch.js";
import { InlineMediaCache } from "../src/inline-media-cache.js";
import { ApprovalGate } from "../src/approval/approval-gate.js";
import { RulesetStorage } from "../src/approval/ruleset-storage.js";
import { AgentRunner } from "../src/agent-runner.js";
import { WorkspaceStore } from "../src/workspace-store.js";

export {
  SessionManager, ConnectionRegistry, EventBus, ToolDispatch,
  InlineMediaCache, ApprovalGate, RulesetStorage, AgentRunner, WorkspaceStore,
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
  eventBus: InstanceType<typeof EventBus>,
  sessionId: string,
): { events: AgentEvent[]; unsub: () => void } {
  const events: AgentEvent[] = [];
  const unsub = eventBus.subscribe(sessionId, (event) => events.push(event));
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
  eventBus: InstanceType<typeof EventBus>;
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
  const eventBus = new EventBus();
  const toolDispatch = new ToolDispatch();
  const inlineMediaCache = new InlineMediaCache();
  const rulesetStorage = new RulesetStorage(tmp.path);
  const approvalGate = new ApprovalGate(rulesetStorage, eventBus);
  const workerId = crypto.randomUUID();

  const workspaceStore = new WorkspaceStore(tmp.path);
  const pluginLoaderLike = opts?.hookRegistry ? {
    hookRegistry: opts.hookRegistry,
    hookLogger: { warn: () => {} },
    pluginTools: [],
    sessionToolFactories: [],
  } : undefined;
  const agentRunner = new AgentRunner(
    sessionMgr, eventBus, connectionRegistry, toolDispatch,
    makeProviderState(opts?.contextWindow), "gemini/test",
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
    tmp, env, sessionMgr, connectionRegistry, eventBus,
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
