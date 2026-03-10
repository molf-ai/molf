import {
  createTRPCClient,
  createWSClient,
  wsLink,
} from "./trpc-client.js";
import WebSocket from "ws";
import type { AppRouter } from "@molf-ai/server";
import { errorMessage } from "@molf-ai/protocol";
import type { WorkerAgentInfo, WorkerMetadata, WorkerSkillInfo, WorkerToolInfo, FsReadRequest } from "@molf-ai/protocol";
import { getLogger } from "@logtape/logtape";
import type { ToolExecutor } from "./tool-executor.js";
import { saveUploadedFile } from "./uploads.js";
import { resolve } from "path";
import { readFile, stat } from "fs/promises";

const connLogger = getLogger(["molf", "worker", "conn"]);
const toolLogger = getLogger(["molf", "worker", "tool"]);

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "registered"
  | "reconnecting";

/** Create a WebSocket subclass that injects Authorization header on every connection. */
function createAuthWebSocket(token: string) {
  return class AuthWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } as unknown as typeof globalThis.WebSocket;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const MUTATION_MAX_RETRIES = 3;
const MUTATION_RETRY_DELAY_MS = 1_000;
const OUTPUT_DIR = ".molf/tool-output";
const FS_READ_MAX_SIZE = 30 * 1024 * 1024; // 30MB

export interface WorkerConnectionOptions {
  serverUrl: string;
  token: string;
  workerId: string;
  name: string;
  workdir: string;
  toolExecutor: ToolExecutor;
  skills: WorkerSkillInfo[];
  agents: WorkerAgentInfo[];
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

export interface PluginListEntry {
  specifier: string;
  config?: unknown;
}

export class WorkerConnection {
  private _state: ConnectionState = "disconnected";
  private wsClient: WSClient | null = null;
  private trpc: TRPCClient | null = null;
  private toolSub: { unsubscribe: () => void } | null = null;
  private uploadSub: { unsubscribe: () => void } | null = null;
  private fsReadSub: { unsubscribe: () => void } | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private generation = 0;

  /** Plugin list received from server on registration. */
  pluginList: PluginListEntry[] = [];

  constructor(private readonly opts: WorkerConnectionOptions) {}

  get state(): ConnectionState {
    return this._state;
  }

  /** Establish the initial connection. Throws on failure. */
  async connect(): Promise<void> {
    this._state = "connecting";
    await this.establish();
  }

  /** Push a state update to the server. Used by StateWatcher on file changes. */
  async syncState(state: {
    tools: WorkerToolInfo[];
    skills: WorkerSkillInfo[];
    agents: WorkerAgentInfo[];
    metadata?: WorkerMetadata;
  }): Promise<void> {
    if (!this.trpc || this._state !== "registered") {
      throw new Error("Not connected");
    }

    await retry(
      () => {
        if (!this.trpc || this._state !== "registered") {
          throw new Error("Connection lost");
        }
        return this.trpc.worker.syncState.mutate({
          workerId: this.opts.workerId,
          tools: state.tools,
          skills: state.skills,
          agents: state.agents,
          metadata: state.metadata,
        });
      },
      MUTATION_MAX_RETRIES,
      MUTATION_RETRY_DELAY_MS,
    );
  }

  /** Create WebSocket, register with server, subscribe to events. */
  private async establish(): Promise<void> {
    this.generation++;
    const gen = this.generation;

    const url = new URL(this.opts.serverUrl);
    url.searchParams.set("clientId", this.opts.workerId);
    url.searchParams.set("name", this.opts.name);

    const token = this.opts.token;
    this.wsClient = createWSClient({
      url: url.toString(),
      WebSocket: createAuthWebSocket(token),
    });

    this.trpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: this.wsClient })],
    });

    // Register with server
    const toolInfos = this.opts.toolExecutor.getToolInfos();
    connLogger.debug("Registering worker {name} ({workerId}) with {toolCount} tools, {skillCount} skills", {
      name: this.opts.name, workerId: this.opts.workerId, toolCount: toolInfos.length, skillCount: this.opts.skills.length,
    });

    const regResult = await this.trpc.worker.register.mutate({
      workerId: this.opts.workerId,
      name: this.opts.name,
      tools: toolInfos,
      skills: this.opts.skills,
      agents: this.opts.agents,
      metadata: this.opts.metadata,
    }) as { workerId: string; plugins?: PluginListEntry[] };

    // Capture plugin list from server (sent when server has plugin system enabled)
    if (regResult.plugins) {
      this.pluginList = regResult.plugins;
    }

    // Subscribe to tool calls
    this.toolSub = this.trpc.worker.onToolCall.subscribe(
      { workerId: this.opts.workerId },
      {
        onData: (request) => this.handleToolCall(request),
        onError: () => this.handleDisconnect(gen),
      },
    );

    // Subscribe to upload requests
    this.uploadSub = this.trpc.worker.onUpload.subscribe(
      { workerId: this.opts.workerId },
      {
        onData: (request) => this.handleUpload(request),
        onError: () => this.handleDisconnect(gen),
      },
    );

    // Subscribe to filesystem read requests
    this.fsReadSub = this.trpc.worker.onFsRead.subscribe(
      { workerId: this.opts.workerId },
      {
        onData: (request) => this.handleFsRead(request),
        onError: () => this.handleDisconnect(gen),
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
    toolLogger.debug("Tool call start: {toolName} ({toolCallId})", { toolName: request.toolName, toolCallId: request.toolCallId });

    const startTime = performance.now();
    const envelope = await this.opts.toolExecutor.execute(
      request.toolName,
      request.args,
      request.toolCallId,
    );
    const durationMs = Math.round(performance.now() - startTime);

    if (envelope.error) {
      toolLogger.warn("Tool call failed: {toolName} ({toolCallId})", { toolName: request.toolName, toolCallId: request.toolCallId, error: envelope.error });
    } else {
      toolLogger.debug("Tool call completed: {toolName} ({toolCallId}) in {durationMs}ms", { toolName: request.toolName, toolCallId: request.toolCallId, durationMs });
    }

    try {
      await retry(
        () => {
          if (!this.trpc) throw new Error("Connection lost");
          return this.trpc.worker.toolResult.mutate({
            toolCallId: request.toolCallId,
            output: envelope.output,
            error: envelope.error,
            meta: envelope.meta,
            attachments: envelope.attachments,
          });
        },
        MUTATION_MAX_RETRIES,
        MUTATION_RETRY_DELAY_MS,
      );
    } catch (err) {
      toolLogger.error("Failed to send tool result for {toolCallId}", { toolCallId: request.toolCallId, error: err });
    }
  }

  /** Handle an incoming upload request. */
  private async handleUpload(request: {
    uploadId: string;
    data: string;
    filename: string;
    mimeType: string;
  }): Promise<void> {
    toolLogger.debug("Upload start: {filename} ({uploadId})", { filename: request.filename, uploadId: request.uploadId });

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
      toolLogger.error("Upload failed: {filename}", { filename: request.filename, uploadId: request.uploadId, error: err });
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
      toolLogger.error("Failed to send upload result for {uploadId}", { uploadId: request.uploadId, error: err });
    }
  }

  /** Handle an incoming filesystem read request. */
  private async handleFsRead(request: FsReadRequest): Promise<void> {
    toolLogger.debug("Fs read start: {path} ({requestId})", { path: request.outputId ?? request.path, requestId: request.requestId });

    let content = "";
    let size = 0;
    let error: string | undefined;
    const encoding = "utf-8" as const;

    try {
      // Resolve path from outputId or direct path
      let filePath: string;
      if (request.outputId) {
        filePath = resolve(this.opts.workdir, OUTPUT_DIR, `${request.outputId}.txt`);
      } else if (request.path) {
        filePath = resolve(this.opts.workdir, request.path);
      } else {
        throw new Error("outputId or path required");
      }

      // Security: validate resolved path is within the output directory
      const allowedDir = resolve(this.opts.workdir, OUTPUT_DIR);
      if (!filePath.startsWith(allowedDir + "/")) {
        throw new Error("Access denied: path outside allowed directory");
      }

      // Check file size
      const fileStat = await stat(filePath);
      if (fileStat.size > FS_READ_MAX_SIZE) {
        throw new Error(`File too large (${fileStat.size} bytes, max ${FS_READ_MAX_SIZE})`);
      }

      content = await readFile(filePath, "utf-8");
      size = fileStat.size;
    } catch (err) {
      error = errorMessage(err);
      toolLogger.error("Fs read failed: {path}", { path: request.outputId ?? request.path, requestId: request.requestId, error: err });
    }

    try {
      await retry(
        () => {
          if (!this.trpc) throw new Error("Connection lost");
          return this.trpc.worker.fsReadResult.mutate({
            requestId: request.requestId,
            content,
            size,
            encoding,
            error,
          });
        },
        MUTATION_MAX_RETRIES,
        MUTATION_RETRY_DELAY_MS,
      );
    } catch (err) {
      toolLogger.error("Failed to send fs read result for {requestId}", { requestId: request.requestId, error: err });
    }
  }

  /** Called when the connection is lost. Triggers reconnection. */
  private handleDisconnect(gen: number): void {
    if (this.closed || gen !== this.generation) return;
    this.generation++;

    connLogger.warn("Connection lost");
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

    connLogger.info("Reconnecting in {delayMs}ms (attempt {attempt})...", { delayMs: delay, attempt: this.reconnectAttempt });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.establish();
        connLogger.info("Reconnected successfully");
      } catch (err) {
        connLogger.error("Reconnection failed", { error: err });
        this.teardown();
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** Clean up subscriptions and WebSocket client. */
  private teardown(): void {
    this.toolSub?.unsubscribe();
    this.uploadSub?.unsubscribe();
    this.fsReadSub?.unsubscribe();
    this.toolSub = null;
    this.uploadSub = null;
    this.fsReadSub = null;
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
