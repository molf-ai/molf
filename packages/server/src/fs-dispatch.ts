import type { FsReadRequest, FsReadResult } from "@molf-ai/protocol";
import { WorkerDispatch } from "./worker-dispatch.js";

const FS_TIMEOUT_MS = 30_000;

export class FsDispatch {
  private inner = new WorkerDispatch<FsReadRequest, FsReadResult>(
    (req) => req.requestId,
    (workerId) => ({
      requestId: "",
      content: "",
      size: 0,
      encoding: "utf-8",
      error: `Worker ${workerId} disconnected`,
    }),
  );

  dispatch(workerId: string, request: FsReadRequest): Promise<FsReadResult> {
    return this.inner.dispatch(workerId, request, FS_TIMEOUT_MS);
  }

  async *subscribeWorker(workerId: string, signal: AbortSignal): AsyncGenerator<FsReadRequest> {
    yield* this.inner.subscribeWorker(workerId, signal);
  }

  resolveRead(requestId: string, result: FsReadResult): boolean {
    return this.inner.resolve(requestId, result);
  }

  workerDisconnected(workerId: string): void {
    this.inner.workerDisconnected(workerId);
  }
}
