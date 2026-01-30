import type { ToolCallRequest } from "@molf-ai/protocol";

type ToolCallResolver = (result: { result: unknown; error?: string }) => void;

/**
 * Manages pending tool calls dispatched to workers.
 * The server sends a tool call request to a worker, then waits for the result.
 */
export class ToolDispatch {
  /** Pending tool calls waiting for results: toolCallId → resolver */
  private pending = new Map<string, ToolCallResolver>();
  /** Tool call queues per worker: workerId → queue of pending requests */
  private workerQueues = new Map<string, ToolCallRequest[]>();
  /** Listeners waiting for tool calls per worker */
  private workerListeners = new Map<string, ((request: ToolCallRequest) => void)>();

  /**
   * Dispatch a tool call to a worker. Returns a promise that resolves
   * when the worker sends the result back.
   */
  dispatch(
    workerId: string,
    request: ToolCallRequest,
  ): Promise<{ result: unknown; error?: string }> {
    return new Promise((resolve) => {
      this.pending.set(request.toolCallId, resolve);

      // If a worker listener is waiting, send immediately
      const listener = this.workerListeners.get(workerId);
      if (listener) {
        // Remove listener — it's one-shot (the resolve of a single promise)
        this.workerListeners.delete(workerId);
        listener(request);
      } else {
        // Queue for when the worker subscribes
        if (!this.workerQueues.has(workerId)) {
          this.workerQueues.set(workerId, []);
        }
        this.workerQueues.get(workerId)!.push(request);
      }
    });
  }

  /**
   * Called by a worker subscription to receive tool calls.
   * Returns an async generator that yields tool call requests.
   */
  async *subscribeWorker(
    workerId: string,
    signal: AbortSignal,
  ): AsyncGenerator<ToolCallRequest> {
    // Drain any queued requests first
    const queued = this.workerQueues.get(workerId) ?? [];
    this.workerQueues.delete(workerId);
    for (const request of queued) {
      yield request;
    }

    // Wait for new requests
    while (!signal.aborted) {
      // Drain any items that arrived while we were processing
      const reQueued = this.workerQueues.get(workerId);
      if (reQueued && reQueued.length > 0) {
        this.workerQueues.delete(workerId);
        for (const req of reQueued) {
          yield req;
        }
        continue;
      }

      const request = await new Promise<ToolCallRequest | null>((resolve) => {
        if (signal.aborted) {
          resolve(null);
          return;
        }

        this.workerListeners.set(workerId, resolve);

        const onAbort = () => {
          this.workerListeners.delete(workerId);
          resolve(null);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });

      if (request === null) break;
      yield request;
    }

    this.workerListeners.delete(workerId);
  }

  /**
   * Called when a worker sends back a tool result.
   */
  resolveToolCall(
    toolCallId: string,
    result: unknown,
    error?: string,
  ): boolean {
    const resolver = this.pending.get(toolCallId);
    if (!resolver) return false;

    this.pending.delete(toolCallId);
    resolver({ result, error });
    return true;
  }

  /**
   * Clean up pending tool calls for a worker that disconnected.
   */
  workerDisconnected(workerId: string): void {
    this.workerQueues.delete(workerId);
    this.workerListeners.delete(workerId);
  }
}
