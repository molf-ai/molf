import type { ToolCallRequest, ToolResultMetadata, Attachment } from "@molf-ai/protocol";
import { WorkerDispatch } from "./worker-dispatch.js";

export type ToolCallResult = {
  output: string;
  error?: string;
  meta?: ToolResultMetadata;
  attachments?: Attachment[];
};

export class ToolDispatch {
  private inner = new WorkerDispatch<ToolCallRequest, ToolCallResult>(
    (req) => req.toolCallId,
    (workerId) => ({ output: "", error: `Worker ${workerId} disconnected` }),
  );

  dispatch(workerId: string, request: ToolCallRequest): Promise<ToolCallResult> {
    return this.inner.dispatch(workerId, request);
  }

  async *subscribeWorker(workerId: string, signal: AbortSignal): AsyncGenerator<ToolCallRequest> {
    yield* this.inner.subscribeWorker(workerId, signal);
  }

  resolveToolCall(toolCallId: string, result: ToolCallResult): boolean {
    return this.inner.resolve(toolCallId, result);
  }

  workerDisconnected(workerId: string): void {
    this.inner.workerDisconnected(workerId);
  }
}
