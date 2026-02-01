import { useState, useEffect, useCallback, useRef } from "react";
import {
  createTRPCClient,
  createWSClient,
  wsLink,
} from "../trpc-client.js";
import type { AppRouter, AgentStatus, AgentEvent, SessionMessage, SessionListItem, WorkerInfo, ToolApprovalRequest } from "@molf-ai/protocol";
import type { ToolCallInfo, CompletedToolCallGroup, DisplayMessage } from "../types.js";

export interface UseServerOptions {
  url: string;
  token: string;
  sessionId?: string;
  workerId?: string;
}

export interface UseServerState {
  messages: DisplayMessage[];
  status: AgentStatus;
  streamingContent: string;
  activeToolCalls: ToolCallInfo[];
  completedToolCalls: CompletedToolCallGroup[];
  error: Error | null;
  connected: boolean;
  sessionId: string | null;
  workerId: string | null;
  workerName: string | null;
  pendingApprovals: ToolApprovalRequest[];
}

/** Export for testing */
export function createInitialState(opts: { sessionId?: string; workerId?: string }): UseServerState {
  return {
    messages: [],
    status: "idle",
    streamingContent: "",
    activeToolCalls: [],
    completedToolCalls: [],
    error: null,
    connected: false,
    sessionId: opts.sessionId ?? null,
    workerId: opts.workerId ?? null,
    workerName: null,
    pendingApprovals: [],
  };
}

/** Export for testing */
export function handleEvent(
  prev: UseServerState,
  event: AgentEvent,
): UseServerState {
  switch (event.type) {
    case "status_change":
      return {
        ...prev,
        status: event.status,
        ...(event.status === "idle" ? { streamingContent: "" } : {}),
      };

    case "content_delta":
      return {
        ...prev,
        streamingContent: event.content,
      };

    case "tool_call_start":
      return {
        ...prev,
        activeToolCalls: [
          ...prev.activeToolCalls,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: event.arguments,
          },
        ],
      };

    case "tool_call_end":
      return {
        ...prev,
        activeToolCalls: prev.activeToolCalls.map((tc) =>
          tc.toolCallId === event.toolCallId
            ? { ...tc, result: event.result }
            : tc,
        ),
      };

    case "turn_complete":
      return {
        ...prev,
        messages: [...prev.messages, event.message as DisplayMessage],
        streamingContent: "",
        activeToolCalls: [],
        completedToolCalls:
          prev.activeToolCalls.length > 0
            ? [
                ...prev.completedToolCalls,
                {
                  assistantMessageId: event.message.id,
                  toolCalls: [...prev.activeToolCalls],
                },
              ]
            : prev.completedToolCalls,
      };

    case "error":
      return {
        ...prev,
        error: new Error(event.message),
      };

    case "tool_approval_required":
      return {
        ...prev,
        pendingApprovals: [
          ...prev.pendingApprovals,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: event.arguments,
            sessionId: event.sessionId,
          },
        ],
      };

    default:
      return prev;
  }
}

/** Export for testing — normalizes unknown errors to Error instances. */
export function wrapError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Export for testing — produces a clean reset state preserving connection info. */
export function createResetState(
  connected: boolean,
  sessionId: string | null,
  workerId?: string | null,
  workerName?: string | null,
): UseServerState {
  return {
    messages: [],
    status: "idle",
    streamingContent: "",
    activeToolCalls: [],
    completedToolCalls: [],
    error: null,
    connected,
    sessionId,
    workerId: workerId ?? null,
    workerName: workerName ?? null,
    pendingApprovals: [],
  };
}

/** Export for testing — constructs an optimistic user message for display. */
export function createUserMessage(text: string): DisplayMessage {
  return {
    id: `pending_${Date.now()}`,
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

/** Export for testing — validates preconditions before sending a message. */
export function validateSendPreconditions(
  text: string,
  hasConnection: boolean,
  hasSession: boolean,
): { ok: true } | { ok: false; reason: "empty" } | { ok: false; reason: "error"; error: Error } {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (!hasConnection || !hasSession) {
    return {
      ok: false,
      reason: "error",
      error: new Error(
        !hasSession
          ? "No session established. Check server connection and worker status."
          : "Not connected to server.",
      ),
    };
  }
  return { ok: true };
}

/** Export for testing — removes a tool approval by toolCallId. */
export function removeApproval(
  prev: UseServerState,
  toolCallId: string,
): UseServerState {
  return {
    ...prev,
    pendingApprovals: prev.pendingApprovals.filter(
      (a) => a.toolCallId !== toolCallId,
    ),
  };
}

/** Export for testing — selects first worker or returns an error. */
export function selectWorker(
  workers: Array<{ workerId: string }>,
  errorMessage?: string,
): { workerId: string } | { error: Error } {
  if (workers.length === 0) {
    return {
      error: new Error(
        errorMessage ??
          "No workers connected. Start a worker first:\n  molf worker --name <name> --token <token>",
      ),
    };
  }
  return { workerId: workers[0].workerId };
}

/** Export for testing — selects a worker by ID or returns an error. */
export function selectWorkerById(
  workers: Array<{ workerId: string; name: string }>,
  workerId: string,
): { workerId: string; name: string } | { error: Error } {
  const worker = workers.find((w) => w.workerId === workerId);
  if (!worker) {
    return { error: new Error(`Worker ${workerId} not found or not connected.`) };
  }
  return { workerId: worker.workerId, name: worker.name };
}

/** Export for testing — constructs a system message for display. */
export function createSystemMessage(content: string): DisplayMessage {
  return {
    id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: "system",
    content,
    timestamp: Date.now(),
  };
}

/** Export for testing — applies a loaded session to the state. */
export function applySessionLoaded(
  prev: UseServerState,
  sessionId: string,
  messages: DisplayMessage[],
  workerId?: string | null,
  workerName?: string | null,
): UseServerState {
  return {
    ...prev,
    connected: true,
    sessionId,
    messages,
    workerId: workerId ?? prev.workerId,
    workerName: workerName ?? prev.workerName,
  };
}

export interface UseServerReturn extends UseServerState {
  sendMessage: (text: string) => void;
  abort: () => void;
  reset: () => void;
  approveToolCall: (toolCallId: string) => void;
  denyToolCall: (toolCallId: string) => void;
  addSystemMessage: (content: string) => void;
  listSessions: () => Promise<SessionListItem[]>;
  switchSession: (sessionId: string) => Promise<void>;
  newSession: () => Promise<void>;
  renameSession: (name: string) => Promise<void>;
  listWorkers: () => Promise<WorkerInfo[]>;
  switchWorker: (workerId: string) => Promise<void>;
}

export function useServer(opts: UseServerOptions): UseServerReturn {
  const trpcRef = useRef<ReturnType<typeof createTRPCClient<AppRouter>> | null>(null);
  const wsClientRef = useRef<ReturnType<typeof createWSClient> | null>(null);
  const sessionIdRef = useRef<string | null>(opts.sessionId ?? null);
  const workerIdRef = useRef<string | null>(opts.workerId ?? null);
  const eventUnsubRef = useRef<(() => void) | null>(null);

  const [state, setState] = useState<UseServerState>(() =>
    createInitialState({ sessionId: opts.sessionId }),
  );

  // Initialize connection
  useEffect(() => {
    const url = new URL(opts.url);
    url.searchParams.set("token", opts.token);
    url.searchParams.set("name", "tui");

    const wsClient = createWSClient({ url: url.toString() });
    wsClientRef.current = wsClient;

    const trpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: wsClient })],
    });
    trpcRef.current = trpc;

    // Create or load session
    const initSession = async () => {
      try {
        // Fetch workers to resolve names
        const { workers } = await trpc.agent.list.query();

        if (opts.sessionId) {
          // Load existing session
          const loaded = await trpc.session.load.mutate({
            sessionId: opts.sessionId,
          });
          sessionIdRef.current = loaded.sessionId;
          workerIdRef.current = loaded.workerId;
          const workerName = workers.find((w) => w.workerId === loaded.workerId)?.name ?? null;
          setState((prev) =>
            applySessionLoaded(prev, loaded.sessionId, loaded.messages as DisplayMessage[], loaded.workerId, workerName),
          );
        } else {
          // Resolve workerId: use provided or auto-discover first available worker
          let workerId = opts.workerId;
          if (!workerId) {
            const result = selectWorker(workers);
            if ("error" in result) {
              setState((prev) => ({ ...prev, error: result.error }));
              return;
            }
            workerId = result.workerId;
          }
          workerIdRef.current = workerId;
          const workerName = workers.find((w) => w.workerId === workerId)?.name ?? null;

          // Create new session
          const created = await trpc.session.create.mutate({ workerId });
          sessionIdRef.current = created.sessionId;
          setState((prev) => ({
            ...prev,
            connected: true,
            sessionId: created.sessionId,
            workerId,
            workerName,
          }));
        }

        // Subscribe to events
        const sid = sessionIdRef.current;
        if (sid) {
          subscribeToEvents(trpc, sid);
        }
      } catch (err) {
        setState((prev) => ({ ...prev, error: wrapError(err) }));
      }
    };

    initSession();

    return () => {
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }
      wsClient.close();
      trpcRef.current = null;
      wsClientRef.current = null;
      setState((prev) => ({ ...prev, connected: false }));
    };
  }, []); // Run once

  function subscribeToEvents(
    trpc: ReturnType<typeof createTRPCClient<AppRouter>>,
    sessionId: string,
  ) {
    // Unsubscribe from previous events
    if (eventUnsubRef.current) {
      eventUnsubRef.current();
      eventUnsubRef.current = null;
    }

    const subscription = trpc.agent.onEvents.subscribe(
      { sessionId },
      {
        onData: (event: AgentEvent) => onEvent(event),
        onError: (err) => {
          setState((prev) => ({ ...prev, error: wrapError(err) }));
        },
      },
    );

    eventUnsubRef.current = () => subscription.unsubscribe();
  }

  function onEvent(event: AgentEvent) {
    setState((prev) => handleEvent(prev, event));
  }

  const sendMessage = useCallback((text: string) => {
    const validation = validateSendPreconditions(
      text,
      trpcRef.current !== null,
      sessionIdRef.current !== null,
    );
    if (!validation.ok) {
      if (validation.reason === "error")
        setState((prev) => ({ ...prev, error: validation.error }));
      return;
    }

    const trpc = trpcRef.current!;
    const sessionId = sessionIdRef.current!;

    const userMessage = createUserMessage(text);

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      error: null,
    }));

    trpc.agent.prompt
      .mutate({ sessionId, text })
      .catch((err) => {
        setState((prev) => ({ ...prev, error: wrapError(err) }));
      });
  }, []);

  const abort = useCallback(() => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    trpc.agent.abort.mutate({ sessionId }).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    setState(createResetState(state.connected, state.sessionId, state.workerId, state.workerName));
  }, [state.connected, state.sessionId, state.workerId, state.workerName]);

  const approveToolCall = useCallback((toolCallId: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    trpc.tool.approve
      .mutate({ sessionId, toolCallId })
      .then(() => {
        setState((prev) => removeApproval(prev, toolCallId));
      })
      .catch(() => {});
  }, []);

  const denyToolCall = useCallback((toolCallId: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    trpc.tool.deny
      .mutate({ sessionId, toolCallId })
      .then(() => {
        setState((prev) => removeApproval(prev, toolCallId));
      })
      .catch(() => {});
  }, []);

  const addSystemMessage = useCallback((content: string) => {
    const msg = createSystemMessage(content);
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, msg],
    }));
  }, []);

  const listSessions = useCallback(async (): Promise<SessionListItem[]> => {
    const trpc = trpcRef.current;
    if (!trpc) return [];
    const wid = workerIdRef.current;
    const { sessions } = await trpc.session.list.query(
      wid ? { workerId: wid } : undefined,
    );
    return sessions;
  }, []);

  const switchSession = useCallback(async (sessionId: string) => {
    const trpc = trpcRef.current;
    if (!trpc) return;

    const loaded = await trpc.session.load.mutate({ sessionId });
    sessionIdRef.current = loaded.sessionId;
    workerIdRef.current = loaded.workerId;

    // Resolve worker name
    const { workers } = await trpc.agent.list.query();
    const workerName = workers.find((w) => w.workerId === loaded.workerId)?.name ?? null;

    setState((prev) => ({
      ...createResetState(prev.connected, loaded.sessionId, loaded.workerId, workerName),
      messages: loaded.messages as DisplayMessage[],
    }));

    subscribeToEvents(trpc, loaded.sessionId);
  }, []);

  const newSession = useCallback(async () => {
    const trpc = trpcRef.current;
    if (!trpc) return;

    // Resolve workerId
    let workerId = workerIdRef.current;
    let workerName: string | null = null;
    if (!workerId) {
      const { workers } = await trpc.agent.list.query();
      const result = selectWorker(workers, "No workers connected.");
      if ("error" in result) {
        setState((prev) => ({ ...prev, error: result.error }));
        return;
      }
      workerId = result.workerId;
      workerIdRef.current = workerId;
      workerName = workers.find((w) => w.workerId === workerId)?.name ?? null;
    }

    const created = await trpc.session.create.mutate({ workerId });
    sessionIdRef.current = created.sessionId;

    setState((prev) => createResetState(prev.connected, created.sessionId, workerId, workerName ?? prev.workerName));

    subscribeToEvents(trpc, created.sessionId);
  }, []);

  const renameSession = useCallback(async (name: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    await trpc.session.rename.mutate({ sessionId, name });
  }, []);

  const listWorkers = useCallback(async (): Promise<WorkerInfo[]> => {
    const trpc = trpcRef.current;
    if (!trpc) return [];
    const { workers } = await trpc.agent.list.query();
    return workers as WorkerInfo[];
  }, []);

  const switchWorker = useCallback(async (newWorkerId: string) => {
    const trpc = trpcRef.current;
    if (!trpc) return;

    // Verify worker exists and get name
    const { workers } = await trpc.agent.list.query();
    const result = selectWorkerById(workers, newWorkerId);
    if ("error" in result) {
      setState((prev) => ({ ...prev, error: result.error }));
      return;
    }

    workerIdRef.current = newWorkerId;

    // Create new session for the new worker
    const created = await trpc.session.create.mutate({ workerId: newWorkerId });
    sessionIdRef.current = created.sessionId;

    setState((prev) =>
      createResetState(prev.connected, created.sessionId, newWorkerId, result.name),
    );

    subscribeToEvents(trpc, created.sessionId);
  }, []);

  return {
    ...state,
    sendMessage,
    abort,
    reset,
    approveToolCall,
    denyToolCall,
    addSystemMessage,
    listSessions,
    switchSession,
    newSession,
    renameSession,
    listWorkers,
    switchWorker,
  };
}
