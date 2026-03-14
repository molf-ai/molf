import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ClientOptions } from "ws";
import { getLogger } from "@logtape/logtape";
import { contract, createAuthWebSocket, backoffDelay } from "@molf-ai/protocol";
import type { RpcClient } from "@molf-ai/protocol";
import type { AgentEvent } from "@molf-ai/protocol";

const logger = getLogger(["molf", "telegram", "conn"]);

export interface ConnectionOptions {
  serverUrl: string;
  token: string;
  tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">;
  onReconnect?: () => void;
}

export class ServerConnection {
  client!: RpcClient;
  private ws: WebSocket | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private opts: ConnectionOptions;
  private onReconnect?: () => void;

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
    this.onReconnect = opts.onReconnect;
  }

  /** Establish the initial connection. Throws on failure. */
  async connect(): Promise<void> {
    await this.establish(true);
  }

  /** Graceful shutdown — no reconnect will be attempted. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardown();
  }

  /** Create ws → RPCLink → client, listen for close. */
  private async establish(initial: boolean): Promise<void> {
    this.generation++;
    const gen = this.generation;

    const url = new URL(this.opts.serverUrl);
    url.searchParams.set("clientId", crypto.randomUUID());
    url.searchParams.set("name", "telegram");

    const AuthWebSocket = createAuthWebSocket(this.opts.token, this.opts.tlsOpts);
    const ws = new AuthWebSocket(url.toString());
    this.ws = ws;

    // Wait for the WebSocket to open
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (e: Event) => {
        ws.removeEventListener("open", onOpen);
        reject(e);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });

    const link = new RPCLink({ websocket: ws });
    this.client = createORPCClient(link) as RpcClient;

    ws.addEventListener("close", () => this.handleDisconnect(gen));

    if (initial) {
      logger.info("WebSocket connected");
    } else {
      logger.info("Reconnected successfully");
      this.reconnectAttempt = 0;
      this.onReconnect?.();
    }
  }

  /** Generation guard → teardown → scheduleReconnect. */
  private handleDisconnect(gen: number): void {
    if (this.closed || gen !== this.generation) return;
    this.generation++;

    logger.warn("WebSocket disconnected");
    this.teardown();
    this.scheduleReconnect();
  }

  /** Backoff timer → establish → retry on failure. */
  private scheduleReconnect(): void {
    if (this.closed) return;

    const delay = backoffDelay(this.reconnectAttempt);
    this.reconnectAttempt++;

    logger.info("Reconnecting in {delayMs}ms (attempt {attempt})...", {
      delayMs: delay,
      attempt: this.reconnectAttempt,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.establish(false);
      } catch (err) {
        logger.error("Reconnection failed", { error: err });
        this.teardown();
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** Close ws, null ws (keep stale client so callers don't crash on null). */
  private teardown(): void {
    try {
      this.ws?.close();
    } catch {
      // Already closed
    }
    this.ws = null;
  }
}

export async function resolveWorkerId(
  client: RpcClient,
  preferredWorkerId?: string,
): Promise<string> {
  if (preferredWorkerId) return preferredWorkerId;

  const { workers } = await client.agent.list();
  const online = workers.filter((w) => w.connected);
  if (online.length === 0) {
    throw new Error("No workers connected. Start a worker first.");
  }
  return online[0].workerId;
}

export function subscribeToEvents(
  client: RpcClient,
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
  onError?: (err: unknown) => void,
): () => void {
  const abort = new AbortController();
  (async () => {
    try {
      const iter = await client.agent.onEvents({ sessionId });
      for await (const event of iter) {
        if (abort.signal.aborted) break;
        onEvent(event as AgentEvent);
      }
    } catch (err) {
      if (!abort.signal.aborted) onError?.(err);
    }
  })();
  return () => abort.abort();
}

/** Factory that creates + connects a ServerConnection (preserves call-site API shape). */
export async function connectToServer(opts: ConnectionOptions): Promise<ServerConnection> {
  const connection = new ServerConnection(opts);
  await connection.connect();
  return connection;
}
