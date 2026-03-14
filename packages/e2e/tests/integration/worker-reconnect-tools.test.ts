import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, connectTestWorker, createTestClient, getDefaultWsId, waitUntil } from "../../helpers/index.js";
import type { TestServer } from "../../helpers/index.js";

// =============================================================================
// Worker Reconnect with Changed Tools: verify tool list updates on reconnect
// =============================================================================

describe("Worker Reconnect with Changed Tools", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("reconnecting same workerId with different tools updates tool list", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Connect worker with tool_A
      const worker1 = await connectTestWorker(server.url, server.token, "tool-swap-worker", {
        tool_A: {
          description: "Tool A does something",
          execute: async () => ({ output: "result_A" }),
        },
      });
      const workerId = worker1.workerId;

      // Create session bound to this worker
      const session = await client.client.session.create({
        workerId,
        workspaceId: await getDefaultWsId(client.client, workerId),
      });

      // Verify tool_A is available
      const toolsBefore = await client.client.tool.list({
        sessionId: session.sessionId,
      });
      expect(toolsBefore.tools.map((t) => t.name)).toContain("tool_A");

      // Disconnect worker
      worker1.cleanup();
      await waitUntil(() => !server.instance._ctx.connectionRegistry.isConnected(workerId), 2_000, "worker disconnected");

      // Re-register the SAME workerId with tool_B using the ConnectionRegistry.
      // This simulates a worker reconnecting with a different tool set.
      server.instance._ctx.connectionRegistry.registerWorker({
        id: workerId,
        name: "tool-swap-worker-reconnected",
        connectedAt: Date.now(),
        tools: [{
          name: "tool_B",
          description: "Tool B does something else",
          inputSchema: { type: "object", properties: {} },
        }],
        skills: [],
      });

      // Verify tool_B is available and tool_A is not
      const toolsAfter = await client.client.tool.list({
        sessionId: session.sessionId,
      });
      const toolNames = toolsAfter.tools.map((t) => t.name);
      expect(toolNames).toContain("tool_B");
      expect(toolNames).not.toContain("tool_A");

      // Clean up the simulated registration
      server.instance._ctx.connectionRegistry.unregister(workerId);
    } finally {
      client.cleanup();
    }
  });

  test("tool list reflects all tools from reconnected worker", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Connect worker with two tools
      const worker1 = await connectTestWorker(server.url, server.token, "multi-tool-worker", {
        tool_X: {
          description: "Tool X",
          execute: async () => ({ output: "X" }),
        },
        tool_Y: {
          description: "Tool Y",
          execute: async () => ({ output: "Y" }),
        },
      });
      const workerId = worker1.workerId;

      const session = await client.client.session.create({ workerId, workspaceId: await getDefaultWsId(client.client, workerId) });

      // Verify both tools available
      const toolsBefore = await client.client.tool.list({ sessionId: session.sessionId });
      expect(toolsBefore.tools.map((t) => t.name).sort()).toEqual(["tool_X", "tool_Y"]);

      // Disconnect
      worker1.cleanup();
      await waitUntil(() => !server.instance._ctx.connectionRegistry.isConnected(workerId), 2_000, "worker disconnected");

      // Reconnect same workerId with only tool_Z (replacing both X and Y)
      server.instance._ctx.connectionRegistry.registerWorker({
        id: workerId,
        name: "multi-tool-worker-v2",
        connectedAt: Date.now(),
        tools: [{
          name: "tool_Z",
          description: "Tool Z replaces X and Y",
          inputSchema: { type: "object", properties: {} },
        }],
        skills: [],
      });

      const toolsAfter = await client.client.tool.list({ sessionId: session.sessionId });
      const toolNames = toolsAfter.tools.map((t) => t.name);
      expect(toolNames).toEqual(["tool_Z"]);
      expect(toolNames).not.toContain("tool_X");
      expect(toolNames).not.toContain("tool_Y");

      server.instance._ctx.connectionRegistry.unregister(workerId);
    } finally {
      client.cleanup();
    }
  });

  test("disconnected worker returns empty tool list for bound session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const worker = await connectTestWorker(server.url, server.token, "disconnect-worker", {
        some_tool: {
          description: "Some tool",
          execute: async () => ({ output: "result" }),
        },
      });

      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      // Verify tools available
      const toolsBefore = await client.client.tool.list({
        sessionId: session.sessionId,
      });
      expect(toolsBefore.tools.length).toBeGreaterThan(0);

      // Disconnect worker
      worker.cleanup();
      await waitUntil(() => !server.instance._ctx.connectionRegistry.isConnected(worker.workerId), 2_000, "worker disconnected");

      // Tools should be empty since worker is disconnected
      const toolsAfter = await client.client.tool.list({
        sessionId: session.sessionId,
      });
      expect(toolsAfter.tools).toHaveLength(0);
    } finally {
      client.cleanup();
    }
  });
});
