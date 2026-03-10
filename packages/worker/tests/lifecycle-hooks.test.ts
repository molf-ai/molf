import { describe, test, expect } from "vitest";
import { HookRegistry } from "@molf-ai/protocol";

const noopLogger = { warn: () => {} };

describe("worker lifecycle hook contracts", () => {
  test("worker_start event shape: { workerId, workdir }", async () => {
    const registry = new HookRegistry();
    let captured: any;
    registry.on("worker_start", "test-plugin", (data: any) => {
      captured = data;
    });

    registry.dispatchObserving("worker_start", {
      workerId: "w-123",
      workdir: "/home/user/project",
    }, noopLogger);

    await new Promise(r => setTimeout(r, 20));

    expect(captured).toBeDefined();
    expect(captured.workerId).toBe("w-123");
    expect(captured.workdir).toBe("/home/user/project");
  });

  test("worker_stop event shape: {}", async () => {
    const registry = new HookRegistry();
    let captured: any;
    registry.on("worker_stop", "test-plugin", (data: any) => {
      captured = data;
    });

    registry.dispatchObserving("worker_stop", {}, noopLogger);

    await new Promise(r => setTimeout(r, 20));

    expect(captured).toBeDefined();
    expect(Object.keys(captured)).toHaveLength(0);
  });

  test("handler error doesn't propagate", async () => {
    const registry = new HookRegistry();
    registry.on("worker_start", "bad-plugin", () => {
      throw new Error("Plugin crashed!");
    });

    registry.dispatchObserving("worker_start", {
      workerId: "w-123",
      workdir: "/tmp",
    }, noopLogger);

    await new Promise(r => setTimeout(r, 20));
  });
});
