import { useState, useEffect, useCallback, useRef } from "react";
import {
  createTRPCClient,
  createWSClient,
  wsLink,
} from "../trpc-client.js";
import type { AppRouter } from "@molf-ai/server";
import type { AgentEvent, SessionListItem, WorkerInfo } from "@molf-ai/protocol";

import {
  createInitialState,
  handleEvent,
  createResetState,
  applySessionLoaded,
  removeApproval,
} from "./event-reducer.js";
import type { UseServerOptions, UseServerState } from "./event-reducer.js";

import {
  wrapError,
  createUserMessage,
  createSystemMessage,
  validateSendPreconditions,
  selectWorker,
  selectWorkerById,
} from "./session-actions.js";

// Re-export for consumers and tests
export type { UseServerOptions, UseServerState } from "./event-reducer.js";
export {
  createInitialState,
  handleEvent,
  createResetState,
  applySessionLoaded,
  removeApproval,
} from "./event-reducer.js";
export {
  wrapError,
  createUserMessage,
  createSystemMessage,
  validateSendPreconditions,
  selectWorker,
  selectWorkerById,
} from "./session-actions.js";

export interface UseServerReturn extends UseServerState {
  sendMessage: (text: string) => void;
  executeShell: (command: string, saveToSession?: boolean) => void;
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
    url.searchParams.set("clientId", crypto.randomUUID());
    url.searchParams.set("name", "tui");

    const wsClient = createWSClient({
      url: url.toString(),
      retryDelayMs: (attempt) => {
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        const jitter = delay * 0.25 * (Math.random() * 2 - 1);
        return Math.round(delay + jitter);
      },
      onOpen: () => setState((prev) => ({ ...prev, connected: true })),
      onClose: () => setState((prev) => ({ ...prev, connected: false })),
    });
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
            applySessionLoaded(prev, loaded.sessionId, loaded.messages as any[], loaded.workerId, workerName),
          );
        } else {
          // If workerId provided, filter by it; otherwise list ALL sessions
          const listFilter = opts.workerId ? { workerId: opts.workerId } : undefined;

          // Try to restore the most recent session
          let restored = false;
          try {
            const { sessions } = await trpc.session.list.query(listFilter ? { ...listFilter, limit: 1 } : { limit: 1 });
            if (sessions.length > 0) {
              const loaded = await trpc.session.load.mutate({
                sessionId: sessions[0].sessionId,
              });
              sessionIdRef.current = loaded.sessionId;
              // Derive worker from the loaded session
              const workerId = loaded.workerId;
              workerIdRef.current = workerId;
              const workerName = workers.find((w) => w.workerId === workerId)?.name ?? null;
              setState((prev) =>
                applySessionLoaded(
                  prev,
                  loaded.sessionId,
                  loaded.messages as any[],
                  workerId,
                  workerName,
                ),
              );
              restored = true;
            }
          } catch {
            // Fall through to create new session
          }

          if (!restored) {
            // No sessions — need a worker to create one
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

  const executeShell = useCallback((command: string, saveToSession?: boolean) => {
    if (!trpcRef.current || !sessionIdRef.current) {
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, createSystemMessage("No worker connected")],
      }));
      return;
    }

    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;

    setState((prev) => ({ ...prev, isShellRunning: true }));

    trpc.agent.shellExec
      .mutate({ sessionId, command, saveToSession })
      .then((result) => {
        const parts: string[] = [`$ ${command}`];

        if (result.output) {
          parts.push("", result.output);
          if (result.truncated) parts.push("[output truncated]");
        }

        parts.push("", `Exit ${result.exitCode}`);
        if (saveToSession) parts.push("[saved to context]");

        const resultText = parts.join("\n");
        setState((prev) => ({
          ...prev,
          isShellRunning: false,
          messages: [...prev.messages, createSystemMessage(resultText)],
        }));
      })
      .catch((err: any) => {
        let errorText: string;
        if (err?.data?.code === "CONFLICT") {
          errorText = `$ ${command}\n\nAgent is busy. Wait for the current operation to finish, or use !! to run without saving to context.`;
        } else if (err?.data?.code === "PRECONDITION_FAILED") {
          errorText = `$ ${command}\n\nNo worker connected. Shell commands require an active worker.`;
        } else if (err?.message?.includes("timeout")) {
          errorText = `$ ${command}\n\nShell execution failed: timed out after 120s`;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          errorText = `$ ${command}\n\nShell execution failed: ${msg}`;
        }
        setState((prev) => ({
          ...prev,
          isShellRunning: false,
          messages: [...prev.messages, createSystemMessage(errorText)],
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

    try {
      const loaded = await trpc.session.load.mutate({ sessionId });
      sessionIdRef.current = loaded.sessionId;
      workerIdRef.current = loaded.workerId;

      // Resolve worker name
      const { workers } = await trpc.agent.list.query();
      const workerName = workers.find((w) => w.workerId === loaded.workerId)?.name ?? null;

      setState((prev) => ({
        ...createResetState(prev.connected, loaded.sessionId, loaded.workerId, workerName),
        messages: loaded.messages as any[],
      }));

      subscribeToEvents(trpc, loaded.sessionId);
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const newSession = useCallback(async () => {
    const trpc = trpcRef.current;
    if (!trpc) return;

    try {
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
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const renameSession = useCallback(async (name: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    try {
      await trpc.session.rename.mutate({ sessionId, name });
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
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

    // Try to resume latest session for this worker
    try {
      const { sessions } = await trpc.session.list.query({ workerId: newWorkerId, limit: 1 });
      if (sessions.length > 0) {
        const loaded = await trpc.session.load.mutate({ sessionId: sessions[0].sessionId });
        sessionIdRef.current = loaded.sessionId;
        setState((prev) => ({
          ...createResetState(prev.connected, loaded.sessionId, newWorkerId, result.name),
          messages: loaded.messages as any[],
        }));
        subscribeToEvents(trpc, loaded.sessionId);
        return;
      }
    } catch {
      // Fall through to create new
    }

    // No existing sessions — create new
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
    executeShell,
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
