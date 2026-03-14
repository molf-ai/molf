import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ClientOptions } from "ws";
import { contract, createAuthWebSocket } from "@molf-ai/protocol";
import type { RpcClient } from "@molf-ai/protocol";

export interface TestClient {
  client: RpcClient;
  ws: WebSocket;
  cleanup(): void;
}

/**
 * Create an oRPC WebSocket client connected to a test server.
 * Includes proper cleanup via `.cleanup()`.
 */
export function createTestClient(
  url: string,
  token: string,
  name = "test-client",
  tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">,
): TestClient {
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("clientId", crypto.randomUUID());
  wsUrl.searchParams.set("name", name);

  const AuthWebSocket = createAuthWebSocket(token, tlsOpts);
  const ws = new AuthWebSocket(wsUrl.toString());

  const link = new RPCLink({ websocket: ws });
  const client = createORPCClient(link) as RpcClient;

  return {
    client,
    ws,
    cleanup() {
      try { ws.close(); } catch { /* may already be closed or not yet open */ }
    },
  };
}

/**
 * Create an unauthenticated oRPC client (for pairing code redemption tests).
 */
export function createUnauthClient(
  url: string,
  name = "unauth-client",
): TestClient {
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("clientId", crypto.randomUUID());
  wsUrl.searchParams.set("name", name);

  const ws = new WebSocket(wsUrl.toString());

  const link = new RPCLink({ websocket: ws });
  const client = createORPCClient(link) as RpcClient;

  return {
    client,
    ws,
    cleanup() {
      try { ws.close(); } catch { /* may already be closed or not yet open */ }
    },
  };
}
