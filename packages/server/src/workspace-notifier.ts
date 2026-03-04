import type { WorkspaceEvent } from "@molf-ai/protocol";

type WorkspaceListener = (event: WorkspaceEvent) => void;

/** Key is "workerId:workspaceId" for namespacing. */
function key(workerId: string, workspaceId: string): string {
  return `${workerId}:${workspaceId}`;
}

export class WorkspaceNotifier {
  private listeners = new Map<string, Set<WorkspaceListener>>();

  subscribe(workerId: string, workspaceId: string, listener: WorkspaceListener): () => void {
    const k = key(workerId, workspaceId);
    if (!this.listeners.has(k)) {
      this.listeners.set(k, new Set());
    }
    this.listeners.get(k)!.add(listener);

    return () => {
      const set = this.listeners.get(k);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(k);
      }
    };
  }

  emit(workerId: string, workspaceId: string, event: WorkspaceEvent): void {
    const k = key(workerId, workspaceId);
    const set = this.listeners.get(k);
    if (set) {
      for (const listener of set) {
        listener(event);
      }
    }
  }
}
