import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../../helpers/index.js";
import WebSocket from "ws";

// =============================================================================
// Gap 19: WebSocket keep-alive
//
// The server sends pings every 30s (pingMs) and expects a pong within 10s
// (pongWaitMs). If the client stops responding, the server terminates the
// connection.
//
// We verify this by:
// 1. A normal connection stays open when responding to pings.
// 2. A connection with autoPong disabled gets terminated after ~40s.
// =============================================================================

describe("WebSocket keep-alive", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("normal connection stays open when responding to pings", async () => {
    const url = `${server.url}?token=${server.token}&clientId=${crypto.randomUUID()}&name=keepalive-normal`;
    const ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    // Connection should remain open for a few seconds
    await Bun.sleep(2000);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });

  test(
    "connection without pong response is terminated by server",
    async () => {
      const url = `${server.url}?token=${server.token}&clientId=${crypto.randomUUID()}&name=no-pong-test`;

      // autoPong: false prevents automatic pong responses to WS ping frames
      const ws = new WebSocket(url, { autoPong: false });

      // Also suppress any application-level ping responses by ignoring messages
      ws.on("message", () => {
        // Deliberately ignore all messages (no pong at any level)
      });

      let closed = false;
      let closeTimestamp = 0;
      const openTimestamp = Date.now();

      ws.on("close", () => {
        closed = true;
        closeTimestamp = Date.now();
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      // Server keepAlive: pingMs=30s + pongWaitMs=10s = 40s total
      // Wait up to 45s for the connection to be terminated
      await Bun.sleep(45_000);

      expect(closed).toBe(true);

      // Verify the connection was closed roughly within the expected window
      // (30s-45s after connection — allows for timing variance)
      const elapsed = closeTimestamp - openTimestamp;
      expect(elapsed).toBeGreaterThan(25_000); // at least 25s (some buffer)
      expect(elapsed).toBeLessThan(50_000); // no more than 50s

      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    },
    55_000, // 55s test timeout
  );
});
