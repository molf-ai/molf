import type { WorkspaceEvent } from "@molf-ai/protocol";
import type { ServerConnection } from "./connection.js";

type EventHandler = (event: WorkspaceEvent) => void;

interface WorkspaceEntry {
  unsub: () => void;
  handlers: Set<EventHandler>;
}

/**
 * Manages workspace event subscriptions.
 * One tRPC subscription per active workspace, fan-out to registered handlers.
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
      const subscription = this.connection.trpc.workspace.onEvents.subscribe(
        { workerId: this.workerId, workspaceId },
        {
          onData: (event) => {
            const e = this.workspaces.get(workspaceId);
            if (e) for (const handler of e.handlers) handler(event);
          },
          onError: (err) => onError?.(err),
        },
      );
      entry = { unsub: () => subscription.unsubscribe(), handlers: new Set() };
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
