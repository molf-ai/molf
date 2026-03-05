/**
 * Shared test infrastructure for server package tests.
 *
 * Importing this module triggers `mock.module("ai", ...)` via the ai-mock-harness
 * side-effect — all dynamic imports of server modules done AFTER this import will
 * use the mocked `ai` package.
 */

// Re-export harness setters (static import triggers mock.module as a side-effect)
export { setStreamTextImpl, setGenerateTextImpl } from "@molf-ai/test-utils/ai-mock-harness";

import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { flushAsync } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

export { makeProviderState } from "./_provider-state.js";
import { makeProviderState } from "./_provider-state.js";

// Dynamic imports — safe because mock.module already ran above
export const { SessionManager } = await import("../src/session-mgr.js");
export const { ConnectionRegistry } = await import("../src/connection-registry.js");
export const { EventBus } = await import("../src/event-bus.js");
export const { ToolDispatch } = await import("../src/tool-dispatch.js");
export const { InlineMediaCache } = await import("../src/inline-media-cache.js");
export const { ApprovalGate } = await import("../src/approval/approval-gate.js");
export const { RulesetStorage } = await import("../src/approval/ruleset-storage.js");
export const { AgentRunner } = await import("../src/agent-runner.js");
export const { WorkspaceStore } = await import("../src/workspace-store.js");

import type { WorkerRegistration } from "../src/connection-registry.js";
export type { WorkerRegistration };

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
  const agentRunner = new AgentRunner(
    sessionMgr, eventBus, connectionRegistry, toolDispatch,
    makeProviderState(opts?.contextWindow), "gemini/test",
    inlineMediaCache, approvalGate, workspaceStore,
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
