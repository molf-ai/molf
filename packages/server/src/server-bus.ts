import { getLogger } from "@logtape/logtape";
import type {
  ChannelScope,
  ServerEvent,
  IServerBus,
} from "@molf-ai/protocol";

export type { ChannelScope, ConfigEvent, ProviderSummary, ServerEvent } from "@molf-ai/protocol";

const logger = getLogger(["molf", "server", "bus"]);

type Listener = (event: ServerEvent) => void;

function scopeKey(scope: ChannelScope): string {
  switch (scope.type) {
    case "global":
      return "global";
    case "session":
      return `session:${scope.sessionId}`;
    case "workspace":
      return `workspace:${scope.workerId}:${scope.workspaceId}`;
    case "worker":
      return `worker:${scope.workerId}`;
  }
}

export class ServerBus implements IServerBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(scope: ChannelScope, listener: Listener): () => void {
    const key = scopeKey(scope);
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(listener);

    return () => {
      const set = this.listeners.get(key);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(key);
      }
    };
  }

  emit(scope: ChannelScope, event: ServerEvent): void {
    const key = scopeKey(scope);
    const set = this.listeners.get(key);
    if (set) {
      for (const listener of set) {
        try {
          listener(event);
        } catch (err) {
          logger.error("ServerBus listener threw", { scope: key, error: err });
        }
      }
    }
  }

  hasListeners(scope: ChannelScope): boolean {
    const set = this.listeners.get(scopeKey(scope));
    return !!set && set.size > 0;
  }
}
