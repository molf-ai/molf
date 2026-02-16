import type { UploadRequest } from "@molf-ai/protocol";
import { WorkerDispatch } from "./worker-dispatch.js";

export type UploadResult = { path: string; size: number; error?: string };

export class UploadDispatch {
  private inner = new WorkerDispatch<UploadRequest, UploadResult>(
    (req) => req.uploadId,
    (workerId) => ({ path: "", size: 0, error: `Worker ${workerId} disconnected` }),
  );

  dispatch(workerId: string, request: UploadRequest): Promise<UploadResult> {
    return this.inner.dispatch(workerId, request);
  }

  async *subscribeWorker(workerId: string, signal: AbortSignal): AsyncGenerator<UploadRequest> {
    yield* this.inner.subscribeWorker(workerId, signal);
  }

  resolveUpload(uploadId: string, result: UploadResult): boolean {
    return this.inner.resolve(uploadId, result);
  }

  workerDisconnected(workerId: string): void {
    this.inner.workerDisconnected(workerId);
  }
}
