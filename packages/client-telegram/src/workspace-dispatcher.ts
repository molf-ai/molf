import type { WorkspaceEvent } from "@molf-ai/protocol";
import type { ServerConnection } from "./connection.js";

type EventHandler = (event: WorkspaceEvent) => void;

interface WorkspaceEntry {
  unsub: () => void;
  handlers: Set<EventHandler>;
}

/**
 * Manages workspace event subscriptions.
 * One subscription per active workspace, fan-out to registered handlers.
 * Mirrors SessionEventDispatcher pattern.
 */
export class WorkspaceEventDispatcher {
  private workspaces = new Map<string, WorkspaceEntry>();
  private workerId: string;

  constructor(private connection: ServerConnection, workerId: string) {
    this.workerId = workerId;
  }

  subscribe(
    workspaceId: string,
    onEvent: EventHandler,
    onError?: (err: unknown) => void,
  ): () => void {
    let entry = this.workspaces.get(workspaceId);
    if (!entry) {
      const abort = new AbortController();
      (async () => {
        try {
          const iter = await this.connection.client.workspace.onEvents({
            workerId: this.workerId,
            workspaceId,
          });
          for await (const event of iter) {
            if (abort.signal.aborted) break;
            const e = this.workspaces.get(workspaceId);
            if (e) for (const handler of e.handlers) handler(event as WorkspaceEvent);
          }
        } catch (err) {
          if (!abort.signal.aborted) onError?.(err);
        }
      })();
      entry = { unsub: () => abort.abort(), handlers: new Set() };
      this.workspaces.set(workspaceId, entry);
    }
    entry.handlers.add(onEvent);

    return () => {
      const e = this.workspaces.get(workspaceId);
      if (!e) return;
      e.handlers.delete(onEvent);
      if (e.handlers.size === 0) {
        e.unsub();
        this.workspaces.delete(workspaceId);
      }
    };
  }

  /**
   * Re-subscribe all active workspaces using the current connection client.
   * Called after reconnection to restore event streams.
   */
  resubscribeAll(): void {
    for (const [workspaceId, entry] of this.workspaces) {
      entry.unsub();
      const handlers = entry.handlers;

      const abort = new AbortController();
      (async () => {
        try {
          const iter = await this.connection.client.workspace.onEvents({
            workerId: this.workerId,
            workspaceId,
          });
          for await (const event of iter) {
            if (abort.signal.aborted) break;
            const e = this.workspaces.get(workspaceId);
            if (e) for (const handler of e.handlers) handler(event as WorkspaceEvent);
          }
        } catch {
          // Non-fatal: workspace events are supplementary
        }
      })();

      this.workspaces.set(workspaceId, { unsub: () => abort.abort(), handlers });
    }
  }

  setWorkerId(workerId: string): void {
    if (workerId !== this.workerId) {
      this.cleanup();
    }
    this.workerId = workerId;
  }

  cleanup(): void {
    for (const entry of this.workspaces.values()) {
      entry.unsub();
    }
    this.workspaces.clear();
  }
}
