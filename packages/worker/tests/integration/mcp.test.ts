/**
 * MCP integration tests — real subprocess (mock-mcp-server.ts).
 * Kept in a separate directory from packages/worker/tests/mcp/ so that
 * mock.module() calls in client.test.ts don't contaminate the global
 * module registry used by these tests.
 *
 * Run via: bun test packages/worker/tests/integration/
 */
import { describe, test, expect, afterAll } from "bun:test";
import { resolve } from "path";
import { McpClientManager, createServerCaller } from "../../src/mcp/client.js";
import { adaptMcpTools } from "../../src/mcp/tool-adapter.js";

const MOCK_SERVER_PATH = resolve(import.meta.dir, "../fixtures/mock-mcp-server.ts");

let manager: McpClientManager;

afterAll(async () => {
  if (manager) await manager.closeAll();
});

describe("MCP integration (real mock server)", () => {
  test("connect to mock server and list tools", async () => {
    manager = new McpClientManager();
    await manager.connectAll({
      mock: {
        type: "stdio",
        command: "bun",
        args: ["run", MOCK_SERVER_PATH],
        env: {},
      },
    });

    const servers = manager.getConnectedServers();
    expect(servers).toEqual(["mock"]);

    const tools = await manager.listTools("mock");
    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "echo"]);
  }, 15_000);

  test("call echo tool via adapted WorkerTool", async () => {
    const tools = await manager.listTools("mock");
    const caller = createServerCaller(manager, "mock");
    const adapted = adaptMcpTools("mock", tools, caller);

    const echoTool = adapted.find((t) => t.name === "mock_echo");
    expect(echoTool).toBeDefined();

    const result = await echoTool!.execute!({ message: "hello from integration test" });
    expect(result).toBe("hello from integration test");
  }, 10_000);

  test("call add tool via adapted WorkerTool", async () => {
    const tools = await manager.listTools("mock");
    const caller = createServerCaller(manager, "mock");
    const adapted = adaptMcpTools("mock", tools, caller);

    const addTool = adapted.find((t) => t.name === "mock_add");
    expect(addTool).toBeDefined();

    const result = await addTool!.execute!({ a: 3, b: 7 });
    expect(result).toBe("10");
  }, 10_000);

  test("adapted tools have additionalProperties: false", async () => {
    const tools = await manager.listTools("mock");
    const caller = createServerCaller(manager, "mock");
    const adapted = adaptMcpTools("mock", tools, caller);

    for (const tool of adapted) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.additionalProperties).toBe(false);
    }
  }, 10_000);

  test("closeAll completes without error", async () => {
    await manager.closeAll();
    expect(manager.getConnectedServers()).toEqual([]);
  }, 10_000);
});
