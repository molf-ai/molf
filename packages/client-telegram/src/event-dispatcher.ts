import type { AgentEvent } from "@molf-ai/protocol";
import type { ServerConnection } from "./connection.js";
import { subscribeToEvents } from "./connection.js";

type EventHandler = (event: AgentEvent) => void;

interface SessionEntry {
  unsub: () => void;
  handlers: Set<EventHandler>;
}

/**
 * Manages a single tRPC event subscription per session and fans out
 * events to all registered handlers. This avoids duplicate subscriptions
 * when multiple modules (Renderer, ApprovalManager) listen to the same session.
 */
export class SessionEventDispatcher {
  private sessions = new Map<string, SessionEntry>();

  constructor(private connection: ServerConnection) {}

  subscribe(
    sessionId: string,
    onEvent: EventHandler,
    onError?: (err: unknown) => void,
  ): () => void {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      const unsub = subscribeToEvents(
        this.connection.trpc,
        sessionId,
        (event) => {
          const e = this.sessions.get(sessionId);
          if (e) for (const handler of e.handlers) handler(event);
        },
        onError,
      );
      entry = { unsub, handlers: new Set() };
      this.sessions.set(sessionId, entry);
    }
    entry.handlers.add(onEvent);

    return () => {
      const e = this.sessions.get(sessionId);
      if (!e) return;
      e.handlers.delete(onEvent);
      if (e.handlers.size === 0) {
        e.unsub();
        this.sessions.delete(sessionId);
      }
    };
  }

  cleanup() {
    for (const entry of this.sessions.values()) {
      entry.unsub();
    }
    this.sessions.clear();
  }
}
