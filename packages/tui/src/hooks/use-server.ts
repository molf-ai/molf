import { useState, useEffect, useCallback, useRef } from "react";
import {
  createTRPCClient,
  createWSClient,
  wsLink,
} from "@trpc/client";
import type { AppRouter, AgentStatus, AgentEvent, SessionMessage, SessionListItem, ToolApprovalRequest } from "@molf-ai/protocol";
import type { ToolCallInfo, CompletedToolCallGroup, DisplayMessage } from "../types.js";

export interface UseServerOptions {
  url: string;
  token: string;
  sessionId?: string;
  workerId?: string;
}

interface UseServerState {
  messages: DisplayMessage[];
  status: AgentStatus;
  streamingContent: string;
  activeToolCalls: ToolCallInfo[];
  completedToolCalls: CompletedToolCallGroup[];
  error: Error | null;
  connected: boolean;
  sessionId: string | null;
  pendingApprovals: ToolApprovalRequest[];
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
}

export function useServer(opts: UseServerOptions): UseServerReturn {
  const trpcRef = useRef<ReturnType<typeof createTRPCClient<AppRouter>> | null>(null);
  const wsClientRef = useRef<ReturnType<typeof createWSClient> | null>(null);
  const sessionIdRef = useRef<string | null>(opts.sessionId ?? null);
  const workerIdRef = useRef<string | null>(opts.workerId ?? null);
  const eventUnsubRef = useRef<(() => void) | null>(null);

  const [state, setState] = useState<UseServerState>({
    messages: [],
    status: "idle",
    streamingContent: "",
    activeToolCalls: [],
    completedToolCalls: [],
    error: null,
    connected: false,
    sessionId: opts.sessionId ?? null,
    pendingApprovals: [],
  });

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

    setState((prev) => ({ ...prev, connected: true }));

    // Create or load session
    const initSession = async () => {
      try {
        if (opts.sessionId) {
          // Load existing session
          const loaded = await trpc.session.load.mutate({
            sessionId: opts.sessionId,
          });
          sessionIdRef.current = loaded.sessionId;
          setState((prev) => ({
            ...prev,
            sessionId: loaded.sessionId,
            messages: loaded.messages as DisplayMessage[],
          }));
        } else {
          // Resolve workerId: use provided or auto-discover first available worker
          let workerId = opts.workerId;
          if (!workerId) {
            const { workers } = await trpc.agent.list.query();
            if (workers.length === 0) {
              setState((prev) => ({
                ...prev,
                error: new Error(
                  "No workers connected. Start a worker first:\n  molf worker --name <name> --token <token>",
                ),
              }));
              return;
            }
            workerId = workers[0].workerId;
          }
          workerIdRef.current = workerId;

          // Create new session
          const created = await trpc.session.create.mutate({ workerId });
          sessionIdRef.current = created.sessionId;
          setState((prev) => ({
            ...prev,
            sessionId: created.sessionId,
          }));
        }

        // Subscribe to events
        const sid = sessionIdRef.current;
        if (sid) {
          subscribeToEvents(trpc, sid);
        }
      } catch (err) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
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
        onData: (event: AgentEvent) => handleEvent(event),
        onError: (err) => {
          setState((prev) => ({
            ...prev,
            error: err instanceof Error ? err : new Error(String(err)),
          }));
        },
      },
    );

    eventUnsubRef.current = () => subscription.unsubscribe();
  }

  function handleEvent(event: AgentEvent) {
    switch (event.type) {
      case "status_change":
        setState((prev) => ({
          ...prev,
          status: event.status,
          ...(event.status === "idle" ? { streamingContent: "" } : {}),
        }));
        break;

      case "content_delta":
        setState((prev) => ({
          ...prev,
          streamingContent: event.content,
        }));
        break;

      case "tool_call_start":
        setState((prev) => ({
          ...prev,
          activeToolCalls: [
            ...prev.activeToolCalls,
            {
              toolName: event.toolName,
              arguments: event.arguments,
            },
          ],
        }));
        break;

      case "tool_call_end":
        setState((prev) => ({
          ...prev,
          activeToolCalls: prev.activeToolCalls.map((tc) =>
            tc.toolName === event.toolName
              ? { ...tc, result: event.result }
              : tc,
          ),
        }));
        break;

      case "turn_complete":
        setState((prev) => ({
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
        }));
        break;

      case "error":
        setState((prev) => ({
          ...prev,
          error: new Error(event.message),
        }));
        break;

      case "tool_approval_required":
        setState((prev) => ({
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
        }));
        break;
    }
  }

  const sendMessage = useCallback((text: string) => {
    if (text.trim() === "") return;

    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) {
      setState((prev) => ({
        ...prev,
        error: new Error(
          sessionId === null
            ? "No session established. Check server connection and worker status."
            : "Not connected to server.",
        ),
      }));
      return;
    }

    // Optimistically add user message
    const userMessage: DisplayMessage = {
      id: `pending_${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      error: null,
    }));

    trpc.agent.prompt
      .mutate({ sessionId, text })
      .catch((err) => {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      });
  }, []);

  const abort = useCallback(() => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    trpc.agent.abort.mutate({ sessionId }).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    setState({
      messages: [],
      status: "idle",
      streamingContent: "",
      activeToolCalls: [],
      completedToolCalls: [],
      error: null,
      connected: state.connected,
      sessionId: state.sessionId,
      pendingApprovals: [],
    });
  }, [state.connected, state.sessionId]);

  const approveToolCall = useCallback((toolCallId: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    trpc.tool.approve
      .mutate({ sessionId, toolCallId })
      .then(() => {
        setState((prev) => ({
          ...prev,
          pendingApprovals: prev.pendingApprovals.filter(
            (a) => a.toolCallId !== toolCallId,
          ),
        }));
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
        setState((prev) => ({
          ...prev,
          pendingApprovals: prev.pendingApprovals.filter(
            (a) => a.toolCallId !== toolCallId,
          ),
        }));
      })
      .catch(() => {});
  }, []);

  const addSystemMessage = useCallback((content: string) => {
    const msg: DisplayMessage = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: "system",
      content,
      timestamp: Date.now(),
    };
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, msg],
    }));
  }, []);

  const listSessions = useCallback(async (): Promise<SessionListItem[]> => {
    const trpc = trpcRef.current;
    if (!trpc) return [];
    const { sessions } = await trpc.session.list.query();
    return sessions;
  }, []);

  const switchSession = useCallback(async (sessionId: string) => {
    const trpc = trpcRef.current;
    if (!trpc) return;

    const loaded = await trpc.session.load.mutate({ sessionId });
    sessionIdRef.current = loaded.sessionId;

    setState((prev) => ({
      ...prev,
      sessionId: loaded.sessionId,
      messages: loaded.messages as DisplayMessage[],
      status: "idle",
      streamingContent: "",
      activeToolCalls: [],
      completedToolCalls: [],
      error: null,
      pendingApprovals: [],
    }));

    subscribeToEvents(trpc, loaded.sessionId);
  }, []);

  const newSession = useCallback(async () => {
    const trpc = trpcRef.current;
    if (!trpc) return;

    // Resolve workerId
    let workerId = workerIdRef.current;
    if (!workerId) {
      const { workers } = await trpc.agent.list.query();
      if (workers.length === 0) {
        setState((prev) => ({
          ...prev,
          error: new Error("No workers connected."),
        }));
        return;
      }
      workerId = workers[0].workerId;
      workerIdRef.current = workerId;
    }

    const created = await trpc.session.create.mutate({ workerId });
    sessionIdRef.current = created.sessionId;

    setState((prev) => ({
      ...prev,
      sessionId: created.sessionId,
      messages: [],
      status: "idle",
      streamingContent: "",
      activeToolCalls: [],
      completedToolCalls: [],
      error: null,
      pendingApprovals: [],
    }));

    subscribeToEvents(trpc, created.sessionId);
  }, []);

  const renameSession = useCallback(async (name: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    await trpc.session.rename.mutate({ sessionId, name });
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
  };
}
