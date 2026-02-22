import { getLogger } from "@logtape/logtape";
import type { AgentEvent } from "@molf-ai/protocol";

const logger = getLogger(["molf", "server", "event"]);

type Listener = (event: AgentEvent) => void;

/**
 * Per-session event bus. Allows the agent loop to emit events
 * and multiple client subscriptions to receive them.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set());
    }
    this.listeners.get(sessionId)!.add(listener);
    return () => {
      const set = this.listeners.get(sessionId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(sessionId);
      }
    };
  }

  emit(sessionId: string, event: AgentEvent): void {
    const set = this.listeners.get(sessionId);
    if (set) {
      for (const listener of set) {
        try {
          listener(event);
        } catch (err) {
          logger.error("EventBus listener threw", { sessionId, error: err });
        }
      }
    }
  }

  hasListeners(sessionId: string): boolean {
    const set = this.listeners.get(sessionId);
    return !!set && set.size > 0;
  }
}
