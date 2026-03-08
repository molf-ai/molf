import { describe, test, expect, mock } from "bun:test";
import { SyncCoordinator, type SyncSources, type SyncTarget } from "../src/sync-coordinator.js";
import type { WorkerToolInfo, WorkerSkillInfo, WorkerAgentInfo, WorkerMetadata } from "@molf-ai/protocol";

function makeSources(overrides?: Partial<SyncSources>): SyncSources {
  return {
    tools: () => [{ name: "t1", description: "tool 1" }] as WorkerToolInfo[],
    skills: () => [{ name: "s1", description: "skill 1", content: "..." }] as WorkerSkillInfo[],
    agents: () => [] as WorkerAgentInfo[],
    metadata: () => ({ workdir: "/w", agentsDoc: "doc" }) as WorkerMetadata,
    ...overrides,
  };
}

function makeTarget() {
  const calls: Array<{
    tools: WorkerToolInfo[];
    skills: WorkerSkillInfo[];
    agents: WorkerAgentInfo[];
    metadata?: WorkerMetadata;
  }> = [];
  const target: SyncTarget = {
    syncState: mock(async (state) => { calls.push(state); }),
  };
  return { target, calls };
}

describe("SyncCoordinator", () => {
  test("single requestSync sends correct state to target", async () => {
    const sources = makeSources();
    const { target, calls } = makeTarget();
    const coord = new SyncCoordinator(sources, target);

    coord.requestSync();
    await coord.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].tools[0].name).toBe("t1");
    expect(calls[0].skills[0].name).toBe("s1");
    expect(calls[0].metadata?.workdir).toBe("/w");
  });

  test("multiple rapid calls serialize", async () => {
    const sources = makeSources();
    const { target, calls } = makeTarget();
    const coord = new SyncCoordinator(sources, target);

    coord.requestSync();
    coord.requestSync();
    coord.requestSync();
    await coord.flush();

    expect(calls).toHaveLength(3);
  });

  test("source values read at send time, not request time", async () => {
    let toolName = "initial";
    const sources = makeSources({
      tools: () => [{ name: toolName, description: "d" }] as WorkerToolInfo[],
    });
    const { target, calls } = makeTarget();

    // First sync blocks; we change state while it's blocked, then queue a second sync.
    let resolveFirst: () => void;
    const firstBlocks = new Promise<void>((r) => { resolveFirst = r; });
    let callCount = 0;
    target.syncState = async (state) => {
      calls.push(state);
      callCount++;
      if (callCount === 1) await firstBlocks;
    };

    const coord = new SyncCoordinator(sources, target);

    coord.requestSync(); // reads "initial", then blocks on firstBlocks
    await new Promise((r) => setTimeout(r, 10)); // let first doSync start

    // Change state while first sync is in-flight
    toolName = "changed";
    coord.requestSync(); // queued — will read "changed" when it runs

    // Let the first sync complete
    resolveFirst!();
    await coord.flush();

    expect(calls).toHaveLength(2);
    expect(calls[0].tools[0].name).toBe("initial");
    expect(calls[1].tools[0].name).toBe("changed");
  });

  test("target error doesn't break queue — next sync still runs", async () => {
    const sources = makeSources();
    let callCount = 0;
    const calls: unknown[] = [];
    const target: SyncTarget = {
      syncState: async (state) => {
        callCount++;
        if (callCount === 1) throw new Error("network error");
        calls.push(state);
      },
    };
    const coord = new SyncCoordinator(sources, target);

    coord.requestSync(); // will throw
    coord.requestSync(); // should still run

    // flush() itself may reject from the first error, but the second should have run
    try { await coord.flush(); } catch { /* expected */ }

    // Give a tick for the second doSync to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toHaveLength(1);
  });

  test("flush resolves after pending syncs", async () => {
    const sources = makeSources();
    const { target } = makeTarget();
    const coord = new SyncCoordinator(sources, target);

    coord.requestSync();
    coord.requestSync();

    // flush should not resolve until both are done
    await coord.flush();

    expect((target.syncState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });
});
