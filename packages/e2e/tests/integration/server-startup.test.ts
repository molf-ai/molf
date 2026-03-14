import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "net";
import { createTestProviderConfig } from "../../helpers/index.js";
import { createTmpDir, createEnvGuard, type TmpDir } from "@molf-ai/test-utils";
import { startServer, type ServerInstance } from "../../../server/src/server.js";

let tmp: TmpDir;
let server: ServerInstance;
const envGuard = createEnvGuard();

beforeAll(async () => {
  // Clear MOLF_TOKEN so the server generates a random hex token
  envGuard.delete("MOLF_TOKEN");
  tmp = createTmpDir();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: tmp.path,
    model: "gemini/test",
    providerConfig: createTestProviderConfig(tmp.path),
    tls: false,
  });
});

afterAll(() => {
  server?.close();
  tmp?.cleanup();
  envGuard.restore();
});

describe("startServer", () => {
  test("creates WSS on given port", () => {
    expect(server.port).toBeGreaterThan(0);
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
    const server2 = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: tmp2.path,
      model: "gemini/test",
      providerConfig: createTestProviderConfig(tmp2.path),
      tls: false,
    });
    const port = server2.port;

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
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=${server.token}&name=test`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("error", () => resolve(false));
      setTimeout(() => resolve(false), 3_000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  test("WebSocket connection with invalid token rejects procedures", async () => {
    const { createORPCClient } = await import("@orpc/client");
    const { RPCLink } = await import("@orpc/client/websocket");

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}?token=invalid-token&name=test`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", reject);
    });

    const link = new RPCLink({ websocket: ws });
    const client = createORPCClient(link) as any;

    try {
      await client.session.list({});
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("authentication");
    } finally {
      ws.close();
    }
  });
});
