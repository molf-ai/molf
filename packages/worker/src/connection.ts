import { createORPCClient, RPCLink } from "./rpc-client.js";
import type { ClientOptions } from "ws";
import { contract, createAuthWebSocket, errorMessage, backoffDelay } from "@molf-ai/protocol";
import type { RpcClient } from "@molf-ai/protocol";
import type { WorkerAgentInfo, WorkerMetadata, WorkerSkillInfo, WorkerToolInfo, FsReadRequest } from "@molf-ai/protocol";
import { getLogger } from "@logtape/logtape";
import type { ToolExecutor } from "./tool-executor.js";
import { saveUploadedFile } from "./uploads.js";
import { resolve } from "path";
import { readFile, stat } from "fs/promises";
import WebSocket from "ws";

const connLogger = getLogger(["molf", "worker", "conn"]);
const toolLogger = getLogger(["molf", "worker", "tool"]);

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "registered"
  | "reconnecting";

const MUTATION_MAX_RETRIES = 3;
const MUTATION_RETRY_DELAY_MS = 1_000;
const ESTABLISH_TIMEOUT_MS = 5_000;
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
  tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">;
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

export interface PluginListEntry {
  specifier: string;
  config?: unknown;
}

export class WorkerConnection {
  private _state: ConnectionState = "disconnected";
  private ws: WebSocket | null = null;
  private client: RpcClient | null = null;
  private subAbort: AbortController | null = null;
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
    if (!this.client || this._state !== "registered") {
      throw new Error("Not connected");
    }

    await retry(
      () => {
        if (!this.client || this._state !== "registered") {
          throw new Error("Connection lost");
        }
        return this.client.worker.syncState({
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
    const doEstablish = async () => {
      this.generation++;
      const gen = this.generation;

      const url = new URL(this.opts.serverUrl);
      url.searchParams.set("clientId", this.opts.workerId);
      url.searchParams.set("name", this.opts.name);

      const token = this.opts.token;
      const AuthWS = createAuthWebSocket(token, this.opts.tlsOpts);
      const ws = new AuthWS(url.toString()) as unknown as WebSocket;
      this.ws = ws;

      // Wait for WebSocket to open
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });

      const link = new RPCLink({ websocket: ws as any });
      this.client = createORPCClient(link) as RpcClient;

      // Register with server
      const toolInfos = this.opts.toolExecutor.getToolInfos();
      connLogger.debug("Registering worker {name} ({workerId}) with {toolCount} tools, {skillCount} skills", {
        name: this.opts.name, workerId: this.opts.workerId, toolCount: toolInfos.length, skillCount: this.opts.skills.length,
      });

      const regResult = await this.client.worker.register({
        workerId: this.opts.workerId,
        name: this.opts.name,
        tools: toolInfos,
        skills: this.opts.skills,
        agents: this.opts.agents,
        metadata: this.opts.metadata,
      });

      // Capture plugin list from server
      if (regResult.plugins) {
        this.pluginList = regResult.plugins;
      }

      // Start subscription loops
      this.subAbort = new AbortController();
      this.startToolCallLoop(gen);
      this.startUploadLoop(gen);
      this.startFsReadLoop(gen);

      this._state = "registered";
      this.reconnectAttempt = 0;
    };

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(
        `Connection timed out after ${ESTABLISH_TIMEOUT_MS / 1000}s. ` +
        `Check that the server is running at ${this.opts.serverUrl} and the URL is correct.`
      )), ESTABLISH_TIMEOUT_MS);
    });

    try {
      await Promise.race([doEstablish(), timeout]);
    } catch (err) {
      this.teardown();
      throw err;
    }
  }

  /** Run async iteration loop for tool calls. */
  private startToolCallLoop(gen: number): void {
    const client = this.client!;
    const signal = this.subAbort!.signal;
    (async () => {
      try {
        const iter = await client.worker.onToolCall({ workerId: this.opts.workerId });
        for await (const request of iter) {
          if (signal.aborted) break;
          this.handleToolCall(request);
        }
      } catch {
        if (!signal.aborted) this.handleDisconnect(gen);
      }
    })();
  }

  /** Run async iteration loop for upload requests. */
  private startUploadLoop(gen: number): void {
    const client = this.client!;
    const signal = this.subAbort!.signal;
    (async () => {
      try {
        const iter = await client.worker.onUpload({ workerId: this.opts.workerId });
        for await (const request of iter) {
          if (signal.aborted) break;
          this.handleUpload(request);
        }
      } catch {
        if (!signal.aborted) this.handleDisconnect(gen);
      }
    })();
  }

  /** Run async iteration loop for filesystem read requests. */
  private startFsReadLoop(gen: number): void {
    const client = this.client!;
    const signal = this.subAbort!.signal;
    (async () => {
      try {
        const iter = await client.worker.onFsRead({ workerId: this.opts.workerId });
        for await (const request of iter) {
          if (signal.aborted) break;
          this.handleFsRead(request);
        }
      } catch {
        if (!signal.aborted) this.handleDisconnect(gen);
      }
    })();
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
          if (!this.client) throw new Error("Connection lost");
          return this.client.worker.toolResult({
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
          if (!this.client) throw new Error("Connection lost");
          return this.client.worker.uploadResult({
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
      let filePath: string;
      if (request.outputId) {
        filePath = resolve(this.opts.workdir, OUTPUT_DIR, `${request.outputId}.txt`);
      } else if (request.path) {
        filePath = resolve(this.opts.workdir, request.path);
      } else {
        throw new Error("outputId or path required");
      }

      const allowedDir = resolve(this.opts.workdir, OUTPUT_DIR);
      if (!filePath.startsWith(allowedDir + "/")) {
        throw new Error("Access denied: path outside allowed directory");
      }

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
          if (!this.client) throw new Error("Connection lost");
          return this.client.worker.fsReadResult({
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
    this.subAbort?.abort();
    this.subAbort = null;
    try {
      this.ws?.close();
    } catch {
      // Already closed
    }
    this.ws = null;
    this.client = null;
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
