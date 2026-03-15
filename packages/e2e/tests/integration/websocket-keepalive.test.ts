import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, type TestServer, sleep } from "../../helpers/index.js";
import WebSocket from "ws";

// =============================================================================
// Gap 19: WebSocket keep-alive
//
// The server sends pings every 500ms and expects a pong within 300ms
// (configured via startTestServer). If the client stops responding, the server
// terminates the connection.
//
// We verify this by:
// 1. A normal connection stays open when responding to pings.
// 2. A connection with autoPong disabled gets terminated after ~800ms.
// =============================================================================

describe("WebSocket keep-alive", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ pingIntervalMs: 500, pongTimeoutMs: 300 });
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

    // Connection should remain open through a ping cycle
    await sleep(1500);
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

      // Server keepAlive: pingMs=500ms + pongWaitMs=300ms = 800ms total
      // Wait up to 2s for the connection to be terminated
      await sleep(2000);

      expect(closed).toBe(true);

      // Verify the connection was closed roughly within the expected window
      const elapsed = closeTimestamp - openTimestamp;
      expect(elapsed).toBeGreaterThan(300); // at least pongTimeout
      expect(elapsed).toBeLessThan(3000); // no more than 3s

      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    },
    5_000, // 5s test timeout
  );
});
