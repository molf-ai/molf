import { useState, useEffect, useCallback, useRef } from "react";
import {
  createTRPCClient,
  createWSClient,
  wsLink,
} from "../trpc-client.js";
import type { ClientOptions } from "ws";
import type { AppRouter } from "@molf-ai/server";
import { createAuthWebSocket } from "@molf-ai/protocol";
import type { AgentEvent, SessionListItem, WorkerInfo, ModelInfo, Workspace, WorkspaceEvent } from "@molf-ai/protocol";
import type { WorkspaceSessionInfo } from "../components/workspace-picker.js";

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
  approveToolCall: (approvalId: string) => void;
  alwaysApproveToolCall: (approvalId: string) => void;
  denyToolCall: (approvalId: string, feedback?: string) => void;
  addSystemMessage: (content: string) => void;
  listSessions: () => Promise<SessionListItem[]>;
  switchSession: (sessionId: string) => Promise<void>;
  newSession: () => Promise<void>;
  renameSession: (name: string) => Promise<void>;
  listWorkers: () => Promise<WorkerInfo[]>;
  switchWorker: (workerId: string) => Promise<void>;
  listModels: () => Promise<ModelInfo[]>;
  setModel: (modelId: string | null) => Promise<void>;
  listWorkspaces: () => Promise<Workspace[]>;
  listWorkspaceSessions: (workspaceId: string) => Promise<WorkspaceSessionInfo[]>;
  switchWorkspace: (workspaceId: string, sessionId?: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (name: string, workspaceId?: string) => Promise<void>;
  createPairingCode: (name: string) => Promise<{ code: string }>;
  listApiKeys: () => Promise<{ id: string; name: string; createdAt: number; revokedAt: number | null }[]>;
  revokeApiKey: (id: string) => Promise<{ revoked: boolean }>;
}

export function useServer(opts: UseServerOptions): UseServerReturn {
  const trpcRef = useRef<ReturnType<typeof createTRPCClient<AppRouter>> | null>(null);
  const wsClientRef = useRef<ReturnType<typeof createWSClient> | null>(null);
  const sessionIdRef = useRef<string | null>(opts.sessionId ?? null);
  const workerIdRef = useRef<string | null>(opts.workerId ?? null);
  const workspaceIdRef = useRef<string | null>(null);
  const eventUnsubRef = useRef<(() => void) | null>(null);
  const workspaceEventUnsubRef = useRef<(() => void) | null>(null);

  const [state, setState] = useState<UseServerState>(() =>
    createInitialState({ sessionId: opts.sessionId }),
  );

  // Initialize connection
  useEffect(() => {
    const url = new URL(opts.url);
    url.searchParams.set("clientId", crypto.randomUUID());
    url.searchParams.set("name", "tui");

    const token = opts.token;
    const AuthWebSocket = createAuthWebSocket(token, opts.tlsOpts);

    const wsClient = createWSClient({
      url: url.toString(),
      WebSocket: AuthWebSocket,
      retryDelayMs: (attempt) => {
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        const jitter = delay * 0.25 * (Math.random() * 2 - 1);
        return Math.round(delay + jitter);
      },
      onOpen: () => setState((prev) => ({ ...prev, connected: true })),
      onClose: () => setState((prev) => ({ ...prev, connected: false, pendingApprovals: [] })),
    });
    wsClientRef.current = wsClient;

    const trpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: wsClient })],
    });
    trpcRef.current = trpc;

    // Create or load session via workspace
    const initSession = async () => {
      try {
        const { workers } = await trpc.agent.list.query();

        if (opts.sessionId) {
          // Load existing session by explicit ID
          const loaded = await trpc.session.load.mutate({
            sessionId: opts.sessionId,
          });
          sessionIdRef.current = loaded.sessionId;
          workerIdRef.current = loaded.workerId;
          const workerName = workers.find((w) => w.workerId === loaded.workerId)?.name ?? null;

          // Resolve workspace for this session
          let workspaceId: string | null = null;
          let workspaceName: string | null = null;
          let workspaceModel: string | null = null;
          try {
            const workspaces = await trpc.workspace.list.query({ workerId: loaded.workerId });
            const ws = workspaces.find((w) => w.sessions.includes(loaded.sessionId));
            if (ws) {
              workspaceId = ws.id;
              workspaceName = ws.name;
              workspaceModel = ws.config.model ?? null;
            }
          } catch {
            // workspace list failed
          }
          if (!workspaceId) {
            try {
              const { workspace } = await trpc.workspace.ensureDefault.mutate({ workerId: loaded.workerId });
              workspaceId = workspace.id;
              workspaceName = workspace.name;
              workspaceModel = workspace.config.model ?? null;
            } catch { /* non-fatal */ }
          }
          workspaceIdRef.current = workspaceId;

          setState((prev) => ({
            ...applySessionLoaded(prev, loaded.sessionId, loaded.messages as any[], loaded.workerId, workerName, workspaceId, workspaceName),
            currentModel: workspaceModel,
          }));
        } else {
          // Select worker
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

          // Ensure default workspace for this worker
          const { workspace, sessionId: lastSessionId } = await trpc.workspace.ensureDefault.mutate({ workerId });
          workspaceIdRef.current = workspace.id;

          // Load the last session from the workspace
          const wsModel = workspace.config.model ?? null;
          try {
            const loaded = await trpc.session.load.mutate({ sessionId: lastSessionId });
            sessionIdRef.current = loaded.sessionId;
            setState((prev) => ({
              ...applySessionLoaded(prev, loaded.sessionId, loaded.messages as any[], workerId!, workerName, workspace.id, workspace.name),
              currentModel: wsModel,
            }));
          } catch {
            // Session load failed — create new session in workspace
            const created = await trpc.session.create.mutate({ workerId, workspaceId: workspace.id });
            sessionIdRef.current = created.sessionId;
            setState((prev) => ({
              ...prev,
              connected: true,
              sessionId: created.sessionId,
              workerId,
              workerName,
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              currentModel: wsModel,
            }));
          }
        }

        // Subscribe to session events
        const sid = sessionIdRef.current;
        if (sid) {
          subscribeToEvents(trpc, sid);
        }

        // Subscribe to workspace events
        const wid = workerIdRef.current;
        const wsid = workspaceIdRef.current;
        if (wid && wsid) {
          subscribeToWorkspaceEvents(trpc, wid, wsid);
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
      if (workspaceEventUnsubRef.current) {
        workspaceEventUnsubRef.current();
        workspaceEventUnsubRef.current = null;
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

  function subscribeToWorkspaceEvents(
    trpc: ReturnType<typeof createTRPCClient<AppRouter>>,
    workerId: string,
    workspaceId: string,
  ) {
    if (workspaceEventUnsubRef.current) {
      workspaceEventUnsubRef.current();
      workspaceEventUnsubRef.current = null;
    }

    const subscription = trpc.workspace.onEvents.subscribe(
      { workerId, workspaceId },
      {
        onData: (event: WorkspaceEvent) => {
          if (event.type === "config_changed") {
            setState((prev) => ({ ...prev, currentModel: event.config.model ?? null }));
          } else if (event.type === "cron_fired") {
            // If user is viewing the target session, agent events stream in normally.
            // If in a different session, show a notification with switch action.
            if (event.targetSessionId !== sessionIdRef.current) {
              setState((prev) => ({
                ...prev,
                cronNotification: {
                  jobName: event.jobName,
                  targetSessionId: event.targetSessionId,
                  ...(event.error ? { error: event.error } : {}),
                },
              }));
            }
          }
          // session_created: handled natively by /clear, no extra UI needed
        },
        onError: () => {
          // Non-fatal: workspace events are supplementary
        },
      },
    );

    workspaceEventUnsubRef.current = () => subscription.unsubscribe();
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
      cronNotification: null,
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
    setState(createResetState(state.connected, state.sessionId, state.workerId, state.workerName, state.workspaceId, state.workspaceName));
  }, [state.connected, state.sessionId, state.workerId, state.workerName, state.workspaceId, state.workspaceName]);

  const approveToolCall = useCallback((approvalId: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    trpc.tool.approve
      .mutate({ sessionId, approvalId })
      .then((result) => {
        if (result.applied) {
          setState((prev) => removeApproval(prev, approvalId));
        }
      })
      .catch(() => {});
  }, []);

  const alwaysApproveToolCall = useCallback((approvalId: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    trpc.tool.approve
      .mutate({ sessionId, approvalId, always: true })
      .then((result) => {
        if (result.applied) {
          setState((prev) => removeApproval(prev, approvalId));
        }
      })
      .catch(() => {});
  }, []);

  const denyToolCall = useCallback((approvalId: string, feedback?: string) => {
    const trpc = trpcRef.current;
    const sessionId = sessionIdRef.current;
    if (!trpc || !sessionId) return;

    trpc.tool.deny
      .mutate({ sessionId, approvalId, ...(feedback ? { feedback } : {}) })
      .then((result) => {
        if (result.applied) {
          setState((prev) => removeApproval(prev, approvalId));
        }
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
        ...createResetState(prev.connected, loaded.sessionId, loaded.workerId, workerName, prev.workspaceId, prev.workspaceName),
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

      // Ensure workspace context
      let workspaceId = workspaceIdRef.current;
      if (!workspaceId) {
        const { workspace } = await trpc.workspace.ensureDefault.mutate({ workerId });
        workspaceId = workspace.id;
        workspaceIdRef.current = workspaceId;
      }

      const created = await trpc.session.create.mutate({ workerId, workspaceId });
      sessionIdRef.current = created.sessionId;

      setState((prev) => createResetState(prev.connected, created.sessionId, workerId, workerName ?? prev.workerName, workspaceId, prev.workspaceName));

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

    // Get default workspace for new worker
    const { workspace, sessionId } = await trpc.workspace.ensureDefault.mutate({ workerId: newWorkerId });
    workspaceIdRef.current = workspace.id;

    // Load the last session
    const wsModel = workspace.config.model ?? null;
    try {
      const loaded = await trpc.session.load.mutate({ sessionId });
      sessionIdRef.current = loaded.sessionId;
      setState((prev) => ({
        ...createResetState(prev.connected, loaded.sessionId, newWorkerId, result.name, workspace.id, workspace.name),
        messages: loaded.messages as any[],
        currentModel: wsModel,
      }));
      subscribeToEvents(trpc, loaded.sessionId);
    } catch {
      // Session load failed — create new
      const created = await trpc.session.create.mutate({ workerId: newWorkerId, workspaceId: workspace.id });
      sessionIdRef.current = created.sessionId;
      setState((prev) => ({
        ...createResetState(prev.connected, created.sessionId, newWorkerId, result.name, workspace.id, workspace.name),
        currentModel: wsModel,
      }));
      subscribeToEvents(trpc, created.sessionId);
    }

    subscribeToWorkspaceEvents(trpc, newWorkerId, workspace.id);
  }, []);

  const listModels = useCallback(async (): Promise<ModelInfo[]> => {
    const trpc = trpcRef.current;
    if (!trpc) return [];
    const { models } = await trpc.provider.listModels.query();
    return models as ModelInfo[];
  }, []);

  const setModel = useCallback(async (modelId: string | null) => {
    const trpc = trpcRef.current;
    const workerId = workerIdRef.current;
    const workspaceId = workspaceIdRef.current;
    if (!trpc || !workerId || !workspaceId) return;

    const config = modelId ? { model: modelId } : {};
    await trpc.workspace.setConfig.mutate({ workerId, workspaceId, config });
    setState((prev) => ({ ...prev, currentModel: modelId }));
  }, []);

  const listWorkspaces = useCallback(async (): Promise<Workspace[]> => {
    const trpc = trpcRef.current;
    const workerId = workerIdRef.current;
    if (!trpc || !workerId) return [];
    return trpc.workspace.list.query({ workerId });
  }, []);

  const listWorkspaceSessions = useCallback(async (workspaceId: string): Promise<WorkspaceSessionInfo[]> => {
    const trpc = trpcRef.current;
    const workerId = workerIdRef.current;
    if (!trpc || !workerId) return [];
    return trpc.workspace.sessions.query({ workerId, workspaceId });
  }, []);

  const switchWorkspace = useCallback(async (workspaceId: string, sessionId?: string) => {
    const trpc = trpcRef.current;
    const workerId = workerIdRef.current;
    if (!trpc || !workerId) return;

    try {
      // Get workspace info
      const workspaces = await trpc.workspace.list.query({ workerId });
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace) {
        setState((prev) => ({ ...prev, error: new Error("Workspace not found") }));
        return;
      }
      workspaceIdRef.current = workspace.id;

      // Load the specified session or the workspace's lastSessionId
      const targetSessionId = sessionId ?? workspace.lastSessionId;
      const loaded = await trpc.session.load.mutate({ sessionId: targetSessionId });
      sessionIdRef.current = loaded.sessionId;

      setState((prev) => ({
        ...createResetState(prev.connected, loaded.sessionId, workerId, prev.workerName, workspace.id, workspace.name),
        messages: loaded.messages as any[],
        currentModel: workspace.config.model ?? null,
      }));

      subscribeToEvents(trpc, loaded.sessionId);
      subscribeToWorkspaceEvents(trpc, workerId, workspace.id);
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const createWorkspace = useCallback(async (name: string) => {
    const trpc = trpcRef.current;
    const workerId = workerIdRef.current;
    if (!trpc || !workerId) return;

    try {
      const { workspace, sessionId } = await trpc.workspace.create.mutate({ workerId, name });
      workspaceIdRef.current = workspace.id;
      sessionIdRef.current = sessionId;

      setState((prev) =>
        createResetState(prev.connected, sessionId, workerId, prev.workerName, workspace.id, workspace.name),
      );

      subscribeToEvents(trpc, sessionId);
      subscribeToWorkspaceEvents(trpc, workerId, workspace.id);
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const createPairingCode = useCallback(async (name: string): Promise<{ code: string }> => {
    const trpc = trpcRef.current;
    if (!trpc) throw new Error("Not connected");
    return trpc.auth.createPairingCode.mutate({ name });
  }, []);

  const listApiKeys = useCallback(async () => {
    const trpc = trpcRef.current;
    if (!trpc) return [];
    return trpc.auth.listApiKeys.query();
  }, []);

  const revokeApiKey = useCallback(async (id: string) => {
    const trpc = trpcRef.current;
    if (!trpc) throw new Error("Not connected");
    return trpc.auth.revokeApiKey.mutate({ id });
  }, []);

  const renameWorkspace = useCallback(async (name: string, workspaceId?: string) => {
    const trpc = trpcRef.current;
    const workerId = workerIdRef.current;
    const wsId = workspaceId ?? workspaceIdRef.current;
    if (!trpc || !workerId || !wsId) return;

    try {
      await trpc.workspace.rename.mutate({ workerId, workspaceId: wsId, name });
      if (wsId === workspaceIdRef.current) {
        setState((prev) => ({ ...prev, workspaceName: name }));
      }
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  return {
    ...state,
    sendMessage,
    executeShell,
    abort,
    reset,
    approveToolCall,
    alwaysApproveToolCall,
    denyToolCall,
    addSystemMessage,
    listSessions,
    switchSession,
    newSession,
    renameSession,
    listWorkers,
    switchWorker,
    listModels,
    setModel,
    listWorkspaces,
    listWorkspaceSessions,
    switchWorkspace,
    createWorkspace,
    renameWorkspace,
    createPairingCode,
    listApiKeys,
    revokeApiKey,
  };
}
