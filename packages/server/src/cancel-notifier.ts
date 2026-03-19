/**
 * Fire-and-forget notification queue for tool cancellation.
 * Workers subscribe via async generator; the server pushes cancel events.
 */
export class CancelNotifier {
  private queues = new Map<string, Array<{ toolCallId: string }>>();
  private listeners = new Map<string, () => void>();

  notify(workerId: string, toolCallId: string): void {
    const queue = this.queues.get(workerId);
    if (queue) {
      queue.push({ toolCallId });
    }
    // Wake the subscriber if waiting
    const listener = this.listeners.get(workerId);
    if (listener) {
      this.listeners.delete(workerId);
      listener();
    }
  }

  async *subscribe(
    workerId: string,
    signal: AbortSignal,
  ): AsyncGenerator<{ toolCallId: string }> {
    if (!this.queues.has(workerId)) {
      this.queues.set(workerId, []);
    }

    try {
      while (!signal.aborted) {
        const queue = this.queues.get(workerId);
        if (queue && queue.length > 0) {
          const items = queue.splice(0);
          for (const item of items) {
            yield item;
          }
          continue;
        }

        // Wait for a notification or abort
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }

          const onAbort = () => {
            this.listeners.delete(workerId);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });

          this.listeners.set(workerId, () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
    } finally {
      this.listeners.delete(workerId);
      this.queues.delete(workerId);
    }
  }
}
