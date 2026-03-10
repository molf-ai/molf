import { describe, test, expect } from "vitest";
import { HookRegistry } from "@molf-ai/protocol";

const noopLogger = { warn: () => {} };

describe("server lifecycle hook contracts", () => {
  test("server_start event shape: { port, dataDir }", async () => {
    const registry = new HookRegistry();
    let captured: any;
    registry.on("server_start", "test-plugin", (data: any) => {
      captured = data;
    });

    registry.dispatchObserving("server_start", {
      port: 3000,
      dataDir: "/tmp/data",
    }, noopLogger);

    await new Promise(r => setTimeout(r, 20));

    expect(captured).toBeDefined();
    expect(captured.port).toBe(3000);
    expect(captured.dataDir).toBe("/tmp/data");
  });

  test("server_stop event shape: {}", async () => {
    const registry = new HookRegistry();
    let captured: any;
    registry.on("server_stop", "test-plugin", (data: any) => {
      captured = data;
    });

    registry.dispatchObserving("server_stop", {}, noopLogger);

    await new Promise(r => setTimeout(r, 20));

    expect(captured).toBeDefined();
    expect(Object.keys(captured)).toHaveLength(0);
  });

  test("handler error doesn't propagate", async () => {
    const registry = new HookRegistry();
    registry.on("server_start", "bad-plugin", () => {
      throw new Error("Plugin crashed!");
    });

    // Should not throw
    registry.dispatchObserving("server_start", {
      port: 3000,
      dataDir: "/tmp/data",
    }, noopLogger);

    // Wait for async handler to complete
    await new Promise(r => setTimeout(r, 20));
    // If we got here, no error propagated
  });
});
