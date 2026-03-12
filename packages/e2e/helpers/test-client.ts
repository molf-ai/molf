import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { ClientOptions } from "ws";
import type { AppRouter } from "@molf-ai/server";
import { createAuthWebSocket } from "@molf-ai/protocol";

export interface TestClient {
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
  wsClient: ReturnType<typeof createWSClient>;
  cleanup(): void;
}

/**
 * Create a tRPC WebSocket client connected to a test server.
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

  const wsClient = createWSClient({
    url: wsUrl.toString(),
    WebSocket: AuthWebSocket,
  });
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });

  return {
    trpc,
    wsClient,
    cleanup() {
      wsClient.close();
    },
  };
}

/**
 * Create an unauthenticated tRPC client (for pairing code redemption tests).
 */
export function createUnauthClient(
  url: string,
  name = "unauth-client",
): TestClient {
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("clientId", crypto.randomUUID());
  wsUrl.searchParams.set("name", name);

  const wsClient = createWSClient({ url: wsUrl.toString() });
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });

  return {
    trpc,
    wsClient,
    cleanup() {
      wsClient.close();
    },
  };
}
