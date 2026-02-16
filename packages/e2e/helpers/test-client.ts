import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@molf-ai/protocol";

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
): TestClient {
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("token", token);
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
