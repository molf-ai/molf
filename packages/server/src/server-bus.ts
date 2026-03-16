import { getLogger } from "@logtape/logtape";
import type {
  AgentEvent,
  WorkspaceEvent,
  IEventBus,
  IWorkspaceNotifier,
} from "@molf-ai/protocol";

const logger = getLogger(["molf", "server", "bus"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelScope =
  | { type: "global" }
  | { type: "session"; sessionId: string }
  | { type: "workspace"; workerId: string; workspaceId: string }
  | { type: "worker"; workerId: string };

export type ConfigEvent =
  | { type: "config_changed"; changedKeys: string[] }
  | { type: "provider_state_changed"; providers: ProviderSummary[] };

export interface ProviderSummary {
  id: string;
  name: string;
  hasKey: boolean;
  keySource: "env" | "stored" | "none";
  modelCount: number;
}

export type ServerEvent = AgentEvent | WorkspaceEvent | ConfigEvent;

type Listener = (event: ServerEvent) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ServerBus
// ---------------------------------------------------------------------------

export class ServerBus implements IEventBus, IWorkspaceNotifier {
  private listeners = new Map<string, Set<Listener>>();

  // ---- Generic scope-based API ----

  subscribe(scope: ChannelScope, listener: Listener): () => void;
  // IEventBus overload
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  // IWorkspaceNotifier overload
  subscribe(
    workerId: string,
    workspaceId: string,
    listener: (event: WorkspaceEvent) => void,
  ): () => void;
  subscribe(
    scopeOrId: ChannelScope | string,
    listenerOrWorkspaceId: Listener | ((event: AgentEvent) => void) | string,
    maybeListener?: ((event: WorkspaceEvent) => void),
  ): () => void {
    // Resolve overloads
    let key: string;
    let fn: Listener;

    if (typeof scopeOrId === "object") {
      // scope-based call
      key = scopeKey(scopeOrId);
      fn = listenerOrWorkspaceId as Listener;
    } else if (typeof listenerOrWorkspaceId === "function") {
      // IEventBus: subscribe(sessionId, listener)
      key = scopeKey({ type: "session", sessionId: scopeOrId });
      fn = listenerOrWorkspaceId as Listener;
    } else {
      // IWorkspaceNotifier: subscribe(workerId, workspaceId, listener)
      key = scopeKey({
        type: "workspace",
        workerId: scopeOrId,
        workspaceId: listenerOrWorkspaceId as string,
      });
      fn = maybeListener as Listener;
    }

    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(fn);

    return () => {
      const set = this.listeners.get(key);
      if (set) {
        set.delete(fn);
        if (set.size === 0) this.listeners.delete(key);
      }
    };
  }

  emit(scope: ChannelScope, event: ServerEvent): void;
  // IEventBus overload
  emit(sessionId: string, event: AgentEvent): void;
  // IWorkspaceNotifier overload
  emit(workerId: string, workspaceId: string, event: WorkspaceEvent): void;
  emit(
    scopeOrId: ChannelScope | string,
    eventOrWorkspaceId: ServerEvent | AgentEvent | string,
    maybeEvent?: WorkspaceEvent,
  ): void {
    let key: string;
    let event: ServerEvent;

    if (typeof scopeOrId === "object") {
      // scope-based call
      key = scopeKey(scopeOrId);
      event = eventOrWorkspaceId as ServerEvent;
    } else if (typeof eventOrWorkspaceId === "object") {
      // IEventBus: emit(sessionId, event)
      key = scopeKey({ type: "session", sessionId: scopeOrId });
      event = eventOrWorkspaceId as AgentEvent;
    } else {
      // IWorkspaceNotifier: emit(workerId, workspaceId, event)
      key = scopeKey({
        type: "workspace",
        workerId: scopeOrId,
        workspaceId: eventOrWorkspaceId as string,
      });
      event = maybeEvent!;
    }

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

  hasListeners(scope: ChannelScope): boolean;
  // IEventBus overload
  hasListeners(sessionId: string): boolean;
  hasListeners(scopeOrId: ChannelScope | string): boolean {
    const key =
      typeof scopeOrId === "object"
        ? scopeKey(scopeOrId)
        : scopeKey({ type: "session", sessionId: scopeOrId });
    const set = this.listeners.get(key);
    return !!set && set.size > 0;
  }

  // ---- IEventBus convenience delegates ----

  subscribeSession(
    sessionId: string,
    listener: (event: AgentEvent) => void,
  ): () => void {
    return this.subscribe({ type: "session", sessionId }, listener as Listener);
  }

  emitSession(sessionId: string, event: AgentEvent): void {
    this.emit({ type: "session", sessionId }, event);
  }

  hasSessionListeners(sessionId: string): boolean {
    return this.hasListeners({ type: "session", sessionId });
  }
}
