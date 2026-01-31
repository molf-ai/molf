import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "net";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { startServer, type ServerInstance } from "../src/server.js";

let tmp: TmpDir;
let server: ServerInstance;

beforeAll(() => {
  tmp = createTmpDir();
  server = startServer({ host: "127.0.0.1", port: 0, dataDir: tmp.path });
});

afterAll(() => {
  server.close();
  tmp.cleanup();
});

describe("startServer", () => {
  test("creates WSS on given port", () => {
    const addr = server.wss.address() as { port: number };
    expect(addr.port).toBeGreaterThan(0);
  });

  test("auth token generated and accessible", () => {
    expect(server.token).toMatch(/^[0-9a-f]+$/);
  });

  test("_ctx exposes internal services", () => {
    expect(server._ctx.sessionMgr).toBeTruthy();
    expect(server._ctx.connectionRegistry).toBeTruthy();
    expect(server._ctx.agentRunner).toBeTruthy();
    expect(server._ctx.eventBus).toBeTruthy();
    expect(server._ctx.toolDispatch).toBeTruthy();
  });

  test("close() shuts down cleanly", async () => {
    const tmp2 = createTmpDir();
    const server2 = startServer({ host: "127.0.0.1", port: 0, dataDir: tmp2.path });
    const addr = server2.wss.address() as { port: number };
    const port = addr.port;

    server2.close();

    // Verify port is released by binding to it
    const bound = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => {
        probe.close(() => resolve(true));
      });
    });

    expect(bound).toBe(true);
    tmp2.cleanup();
  });

  test("WebSocket connection with valid token accepted", async () => {
    const addr = server.wss.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}?token=${server.token}&name=test`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("error", () => resolve(false));
      setTimeout(() => resolve(false), 3_000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  test("WebSocket connection with invalid token rejects procedures", async () => {
    const { createTRPCClient, createWSClient, wsLink } = await import("@trpc/client");

    const addr = server.wss.address() as { port: number };
    const wsClient = createWSClient({
      url: `ws://127.0.0.1:${addr.port}?token=invalid-token&name=test`,
    });

    const trpc = createTRPCClient<import("@molf-ai/protocol").AppRouter>({
      links: [wsLink({ client: wsClient })],
    });

    try {
      await trpc.session.list.query();
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("authentication");
    } finally {
      wsClient.close();
    }
  });
});
