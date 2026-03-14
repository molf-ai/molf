import { createReadStream, mkdirSync, rmSync, statSync } from "fs";
import { writeFile, unlink, rm } from "fs/promises";
import { join } from "path";
import { Readable } from "node:stream";
import { LazyFile } from "@mjackson/lazy-file";
import type { LazyContent } from "@mjackson/lazy-file";
import type { UploadRequest } from "@molf-ai/protocol";
import { WorkerDispatch } from "./worker-dispatch.js";

export type UploadResult = { path: string; size: number; error?: string };

const STAGE_TTL_MS = 60_000; // auto-cleanup after 60s

export class UploadDispatch {
  private inner = new WorkerDispatch<UploadRequest, UploadResult>(
    (req) => req.uploadId,
    (workerId) => ({ path: "", size: 0, error: `Worker ${workerId} disconnected` }),
  );

  private staged = new Map<string, {
    path: string;
    name: string;
    type: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private stagedWorker = new Map<string, string>(); // uploadId → workerId
  private stagingDir: string;

  constructor(dataDir: string) {
    this.stagingDir = join(dataDir, "uploads-staging");
    rmSync(this.stagingDir, { recursive: true, force: true });
    mkdirSync(this.stagingDir, { recursive: true });
  }

  dispatch(workerId: string, request: UploadRequest): Promise<UploadResult> {
    return this.inner.dispatch(workerId, request);
  }

  async *subscribeWorker(workerId: string, signal: AbortSignal): AsyncGenerator<UploadRequest> {
    yield* this.inner.subscribeWorker(workerId, signal);
  }

  resolveUpload(uploadId: string, result: UploadResult): boolean {
    return this.inner.resolve(uploadId, result);
  }

  /** Stage an uploaded File to disk for the worker to pull later. */
  async stageFile(uploadId: string, file: File, workerId: string): Promise<void> {
    const path = join(this.stagingDir, uploadId);
    await writeFile(path, Readable.fromWeb(file.stream()));

    const timer = setTimeout(() => {
      this.deleteStaged(uploadId);
    }, STAGE_TTL_MS);

    this.staged.set(uploadId, {
      path,
      name: file.name || "upload",
      type: file.type || "application/octet-stream",
      timer,
    });
    this.stagedWorker.set(uploadId, workerId);
  }

  /** Retrieve a staged file as a lazy-file File (zero-copy disk read). */
  getUploadFile(uploadId: string): File | undefined {
    const entry = this.staged.get(uploadId);
    if (!entry) return undefined;

    clearTimeout(entry.timer);
    this.staged.delete(uploadId);
    this.stagedWorker.delete(uploadId);

    // LazyFile backed by staged file on disk — auto-deletes after oRPC reads it
    let cleaned = false;
    const filePath = entry.path;
    const cleanup = () => {
      if (!cleaned) { cleaned = true; unlink(filePath).catch(() => {}); }
    };

    const content: LazyContent = {
      byteLength: statSync(filePath).size,
      stream(start = 0, end = Infinity) {
        const nodeEnd = end === Infinity ? undefined : end - 1;
        const read = createReadStream(filePath, { start, end: nodeEnd })[Symbol.asyncIterator]();
        return new ReadableStream({
          async pull(controller) {
            const { done, value } = await read.next();
            if (done) {
              controller.close();
              cleanup();
            } else {
              controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            }
          },
        });
      },
    };

    return new LazyFile(content, entry.name, { type: entry.type }) as unknown as File;
  }

  /** Delete a staged file from disk. */
  deleteStaged(uploadId: string): void {
    const entry = this.staged.get(uploadId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.staged.delete(uploadId);
    this.stagedWorker.delete(uploadId);
    unlink(entry.path).catch(() => {});
  }

  workerDisconnected(workerId: string): void {
    this.inner.workerDisconnected(workerId);

    // Clean up staged files for this worker
    for (const [uploadId, wId] of this.stagedWorker) {
      if (wId === workerId) {
        this.deleteStaged(uploadId);
      }
    }
  }

  /** Clean up all staged files on shutdown. */
  async cleanup(): Promise<void> {
    for (const [, entry] of this.staged) {
      clearTimeout(entry.timer);
    }
    this.staged.clear();
    this.stagedWorker.clear();
    await rm(this.stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
