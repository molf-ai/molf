import type { ToolCallRequest } from "@molf-ai/protocol";
import { WorkerDispatch } from "./worker-dispatch.js";

export type ToolCallResult = { result: unknown; error?: string };

export class ToolDispatch {
  private inner = new WorkerDispatch<ToolCallRequest, ToolCallResult>(
    (req) => req.toolCallId,
    (workerId) => ({ result: null, error: `Worker ${workerId} disconnected` }),
  );

  dispatch(workerId: string, request: ToolCallRequest): Promise<ToolCallResult> {
    return this.inner.dispatch(workerId, request);
  }

  async *subscribeWorker(workerId: string, signal: AbortSignal): AsyncGenerator<ToolCallRequest> {
    yield* this.inner.subscribeWorker(workerId, signal);
  }

  resolveToolCall(toolCallId: string, result: unknown, error?: string): boolean {
    return this.inner.resolve(toolCallId, { result, error });
  }

  workerDisconnected(workerId: string): void {
    this.inner.workerDisconnected(workerId);
  }
}
