import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import WebSocket from "ws";
import { getLogger } from "@logtape/logtape";
import type { AppRouter } from "@molf-ai/server";
import type { AgentEvent } from "@molf-ai/protocol";

const logger = getLogger(["molf", "telegram", "conn"]);

export interface ConnectionOptions {
  serverUrl: string;
  token: string;
}

export interface ServerConnection {
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
  wsClient: ReturnType<typeof createWSClient>;
  close: () => void;
}

export function connectToServer(opts: ConnectionOptions): ServerConnection {
  const url = new URL(opts.serverUrl);
  url.searchParams.set("clientId", crypto.randomUUID());
  url.searchParams.set("name", "telegram");

  const token = opts.token;
  const AuthWebSocket = class extends WebSocket {
    constructor(wsUrl: string | URL, protocols?: string | string[]) {
      super(wsUrl, protocols, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } as unknown as typeof globalThis.WebSocket;

  const wsClient = createWSClient({
    url: url.toString(),
    WebSocket: AuthWebSocket,
    retryDelayMs: (attempt) => {
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      const jitter = delay * 0.25 * (Math.random() * 2 - 1);
      return Math.round(delay + jitter);
    },
    onOpen: () => logger.info("WebSocket connected"),
    onClose: () => logger.warn("WebSocket disconnected, reconnecting..."),
  });

  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });

  return {
    trpc,
    wsClient,
    close: () => wsClient.close(),
  };
}

export async function resolveWorkerId(
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>,
  preferredWorkerId?: string,
): Promise<string> {
  if (preferredWorkerId) return preferredWorkerId;

  const { workers } = await trpc.agent.list.query();
  const online = workers.filter((w) => w.connected);
  if (online.length === 0) {
    throw new Error(
      "No workers connected. Start a worker first:\n  bun run dev:worker -- --name <name> --token <token>",
    );
  }
  return online[0].workerId;
}

export function subscribeToEvents(
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>,
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
  onError?: (err: unknown) => void,
): () => void {
  const subscription = trpc.agent.onEvents.subscribe(
    { sessionId },
    {
      onData: onEvent,
      onError: (err) => onError?.(err),
    },
  );
  return () => subscription.unsubscribe();
}
