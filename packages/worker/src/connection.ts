import {
  createTRPCClient,
  createWSClient,
  wsLink,
} from "./trpc-client.js";
import type { AppRouter } from "@molf-ai/server";
import { errorMessage } from "@molf-ai/protocol";
import type { WorkerSkillInfo } from "@molf-ai/protocol";
import type { ToolExecutor } from "./tool-executor.js";
import { saveUploadedFile } from "./uploads.js";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "registered"
  | "reconnecting";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const MUTATION_MAX_RETRIES = 3;
const MUTATION_RETRY_DELAY_MS = 1_000;

export interface WorkerConnectionOptions {
  serverUrl: string;
  token: string;
  workerId: string;
  name: string;
  workdir: string;
  toolExecutor: ToolExecutor;
  skills: WorkerSkillInfo[];
  metadata?: Record<string, unknown>;
}

/** Calculate backoff delay with jitter. */
function backoffDelay(attempt: number): number {
  const delay = Math.min(
    INITIAL_BACKOFF_MS * BACKOFF_MULTIPLIER ** attempt,
    MAX_BACKOFF_MS,
  );
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

/** Retry an async operation with linear backoff. */
async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
}

type TRPCClient = ReturnType<typeof createTRPCClient<AppRouter>>;
type WSClient = ReturnType<typeof createWSClient>;

export class WorkerConnection {
  private _state: ConnectionState = "disconnected";
  private wsClient: WSClient | null = null;
  private trpc: TRPCClient | null = null;
  private toolSub: { unsubscribe: () => void } | null = null;
  private uploadSub: { unsubscribe: () => void } | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private disconnectHandled = false;

  constructor(private readonly opts: WorkerConnectionOptions) {}

  get state(): ConnectionState {
    return this._state;
  }

  /** Establish the initial connection. Throws on failure. */
  async connect(): Promise<void> {
    this._state = "connecting";
    await this.establish();
  }

  /** Create WebSocket, register with server, subscribe to events. */
  private async establish(): Promise<void> {
    this.disconnectHandled = false;

    const url = new URL(this.opts.serverUrl);
    url.searchParams.set("token", this.opts.token);
    url.searchParams.set("clientId", this.opts.workerId);
    url.searchParams.set("name", this.opts.name);

    this.wsClient = createWSClient({ url: url.toString() });

    this.trpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: this.wsClient })],
    });

    // Register with server
    const toolInfos = this.opts.toolExecutor.getToolInfos();
    console.log(
      `Registering worker "${this.opts.name}" (${this.opts.workerId}) with ${toolInfos.length} tools, ${this.opts.skills.length} skills`,
    );

    await this.trpc.worker.register.mutate({
      workerId: this.opts.workerId,
      name: this.opts.name,
      tools: toolInfos,
      skills: this.opts.skills,
      metadata: this.opts.metadata,
    });

    console.log("Worker registered successfully.");

    // Subscribe to tool calls
    this.toolSub = this.trpc.worker.onToolCall.subscribe(
      { workerId: this.opts.workerId },
      {
        onData: (request) => this.handleToolCall(request),
        onError: () => this.handleDisconnect(),
      },
    );

    // Subscribe to upload requests
    this.uploadSub = this.trpc.worker.onUpload.subscribe(
      { workerId: this.opts.workerId },
      {
        onData: (request) => this.handleUpload(request),
        onError: () => this.handleDisconnect(),
      },
    );

    this._state = "registered";
    this.reconnectAttempt = 0;
  }

  /** Handle an incoming tool call request. */
  private async handleToolCall(request: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    console.log(`Tool call: ${request.toolName} (${request.toolCallId})`);

    const { result, error } = await this.opts.toolExecutor.execute(
      request.toolName,
      request.args,
    );

    try {
      await retry(
        () => {
          if (!this.trpc) throw new Error("Connection lost");
          return this.trpc.worker.toolResult.mutate({
            toolCallId: request.toolCallId,
            result,
            error,
          });
        },
        MUTATION_MAX_RETRIES,
        MUTATION_RETRY_DELAY_MS,
      );
    } catch (err) {
      console.error(
        "Failed to send tool result:",
        errorMessage(err),
      );
    }
  }

  /** Handle an incoming upload request. */
  private async handleUpload(request: {
    uploadId: string;
    data: string;
    filename: string;
    mimeType: string;
  }): Promise<void> {
    console.log(`Upload: ${request.filename} (${request.uploadId})`);

    let path = "";
    let size = 0;
    let error: string | undefined;

    try {
      const buffer = Buffer.from(request.data, "base64");
      const saved = await saveUploadedFile(
        this.opts.workdir,
        buffer,
        request.filename,
      );
      path = saved.path;
      size = saved.size;
    } catch (err) {
      error = errorMessage(err);
      console.error(`Upload failed: ${error}`);
    }

    try {
      await retry(
        () => {
          if (!this.trpc) throw new Error("Connection lost");
          return this.trpc.worker.uploadResult.mutate({
            uploadId: request.uploadId,
            path,
            size,
            error,
          });
        },
        MUTATION_MAX_RETRIES,
        MUTATION_RETRY_DELAY_MS,
      );
    } catch (err) {
      console.error(
        "Failed to send upload result:",
        errorMessage(err),
      );
    }
  }

  /** Called when the connection is lost. Triggers reconnection. */
  private handleDisconnect(): void {
    if (this.closed || this.disconnectHandled) return;
    this.disconnectHandled = true;

    console.log("Connection lost.");
    this._state = "disconnected";
    this.teardown();
    this.scheduleReconnect();
  }

  /** Schedule a reconnection attempt with exponential backoff. */
  private scheduleReconnect(): void {
    if (this.closed) return;

    const delay = backoffDelay(this.reconnectAttempt);
    this.reconnectAttempt++;
    this._state = "reconnecting";

    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.establish();
        console.log("Reconnected successfully.");
      } catch (err) {
        console.error(
          "Reconnection failed:",
          errorMessage(err),
        );
        this.teardown();
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** Clean up subscriptions and WebSocket client. */
  private teardown(): void {
    this.toolSub?.unsubscribe();
    this.uploadSub?.unsubscribe();
    this.toolSub = null;
    this.uploadSub = null;
    try {
      this.wsClient?.close();
    } catch {
      // Already closed
    }
    this.wsClient = null;
    this.trpc = null;
  }

  /** Gracefully shut down the connection. No reconnection will be attempted. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardown();
    this._state = "disconnected";
  }
}

/**
 * Connect to the server and return a connection handle.
 * The connection will automatically reconnect on disconnect.
 */
export async function connectToServer(
  opts: WorkerConnectionOptions,
): Promise<WorkerConnection> {
  const connection = new WorkerConnection(opts);
  await connection.connect();
  return connection;
}
