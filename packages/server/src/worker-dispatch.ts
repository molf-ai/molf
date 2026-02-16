/**
 * Generic dispatch pattern for server→worker request/response pairs.
 * Used by ToolDispatch and UploadDispatch.
 *
 * TRequest: the request type sent to the worker (must have an ID field)
 * TResult: the result type returned by the worker
 */
export class WorkerDispatch<TRequest, TResult> {
  private pending = new Map<string, (result: TResult) => void>();
  private pendingWorker = new Map<string, string>();
  private workerQueues = new Map<string, TRequest[]>();
  private workerListeners = new Map<string, (request: TRequest) => void>();

  /**
   * @param getId - extracts the unique ID from a request
   * @param disconnectResult - factory for the error result when a worker disconnects
   */
  constructor(
    private getId: (request: TRequest) => string,
    private disconnectResult: (workerId: string) => TResult,
  ) {}

  dispatch(workerId: string, request: TRequest): Promise<TResult> {
    const id = this.getId(request);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.pendingWorker.set(id, workerId);

      const listener = this.workerListeners.get(workerId);
      if (listener) {
        this.workerListeners.delete(workerId);
        listener(request);
      } else {
        if (!this.workerQueues.has(workerId)) {
          this.workerQueues.set(workerId, []);
        }
        this.workerQueues.get(workerId)!.push(request);
      }
    });
  }

  async *subscribeWorker(
    workerId: string,
    signal: AbortSignal,
  ): AsyncGenerator<TRequest> {
    const queued = this.workerQueues.get(workerId) ?? [];
    this.workerQueues.delete(workerId);
    for (const request of queued) {
      yield request;
    }

    while (!signal.aborted) {
      const reQueued = this.workerQueues.get(workerId);
      if (reQueued && reQueued.length > 0) {
        this.workerQueues.delete(workerId);
        for (const req of reQueued) {
          yield req;
        }
        continue;
      }

      const request = await new Promise<TRequest | null>((resolve) => {
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

  resolve(id: string, result: TResult): boolean {
    const resolver = this.pending.get(id);
    if (!resolver) return false;

    this.pending.delete(id);
    this.pendingWorker.delete(id);
    resolver(result);
    return true;
  }

  workerDisconnected(workerId: string): void {
    this.workerQueues.delete(workerId);
    this.workerListeners.delete(workerId);

    for (const [id, ownerId] of this.pendingWorker) {
      if (ownerId === workerId) {
        const resolver = this.pending.get(id);
        if (resolver) {
          this.pending.delete(id);
          resolver(this.disconnectResult(workerId));
        }
        this.pendingWorker.delete(id);
      }
    }
  }
}
