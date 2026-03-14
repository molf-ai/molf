import { useState, useEffect, useCallback, useRef } from "react";
import { createORPCClient, RPCLink } from "../rpc-client.js";
import type { ClientOptions } from "ws";
import { contract, createAuthWebSocket, backoffDelay } from "@molf-ai/protocol";
import type { RpcClient } from "@molf-ai/protocol";
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
  const clientRef = useRef<RpcClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
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
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let initialised = false;

    function establishConnection() {
      const url = new URL(opts.url);
      url.searchParams.set("clientId", crypto.randomUUID());
      url.searchParams.set("name", "tui");

      const token = opts.token;
      const AuthWebSocket = createAuthWebSocket(token, opts.tlsOpts);
      const ws = new AuthWebSocket(url.toString());
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        setState((prev) => ({ ...prev, connected: true, reconnecting: false }));
        reconnectAttempt = 0;
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        setState((prev) => ({ ...prev, connected: false, reconnecting: true, pendingApprovals: [] }));
        scheduleReconnect();
      });

      const link = new RPCLink({ websocket: ws });
      const client = createORPCClient(link) as RpcClient;
      clientRef.current = client;

      if (!initialised) {
        initialised = true;
        initSession(client);
      } else {
        // Re-subscribe to events after reconnect
        const sid = sessionIdRef.current;
        if (sid) subscribeToEvents(client, sid);
        const wid = workerIdRef.current;
        const wsid = workspaceIdRef.current;
        if (wid && wsid) subscribeToWorkspaceEvents(client, wid, wsid);
      }
    }

    function scheduleReconnect() {
      if (closed) return;
      const delay = backoffDelay(reconnectAttempt);
      reconnectAttempt++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!closed) establishConnection();
      }, delay);
    }

    // Create or load session via workspace
    const initSession = async (client: RpcClient) => {
      try {
        const { workers } = await client.agent.list();

        if (opts.sessionId) {
          const loaded = await client.session.load({ sessionId: opts.sessionId });
          sessionIdRef.current = loaded.sessionId;
          workerIdRef.current = loaded.workerId;
          const workerName = workers.find((w) => w.workerId === loaded.workerId)?.name ?? null;

          let workspaceId: string | null = null;
          let workspaceName: string | null = null;
          let workspaceModel: string | null = null;
          try {
            const workspaces = await client.workspace.list({ workerId: loaded.workerId });
            const ws = workspaces.find((w) => w.sessions.includes(loaded.sessionId));
            if (ws) {
              workspaceId = ws.id;
              workspaceName = ws.name;
              workspaceModel = ws.config.model ?? null;
            }
          } catch { /* workspace list failed */ }
          if (!workspaceId) {
            try {
              const { workspace } = await client.workspace.ensureDefault({ workerId: loaded.workerId });
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

          const { workspace, sessionId: lastSessionId } = await client.workspace.ensureDefault({ workerId });
          workspaceIdRef.current = workspace.id;

          const wsModel = workspace.config.model ?? null;
          try {
            const loaded = await client.session.load({ sessionId: lastSessionId });
            sessionIdRef.current = loaded.sessionId;
            setState((prev) => ({
              ...applySessionLoaded(prev, loaded.sessionId, loaded.messages as any[], workerId!, workerName, workspace.id, workspace.name),
              currentModel: wsModel,
            }));
          } catch {
            const created = await client.session.create({ workerId, workspaceId: workspace.id });
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

        const sid = sessionIdRef.current;
        if (sid) {
          subscribeToEvents(client, sid);
        }

        const wid = workerIdRef.current;
        const wsid = workspaceIdRef.current;
        if (wid && wsid) {
          subscribeToWorkspaceEvents(client, wid, wsid);
        }
      } catch (err) {
        setState((prev) => ({ ...prev, error: wrapError(err) }));
      }
    };

    establishConnection();

    return () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }
      if (workspaceEventUnsubRef.current) {
        workspaceEventUnsubRef.current();
        workspaceEventUnsubRef.current = null;
      }
      wsRef.current?.close();
      clientRef.current = null;
      wsRef.current = null;
      setState((prev) => ({ ...prev, connected: false, reconnecting: false }));
    };
  }, []); // Run once

  function subscribeToEvents(client: RpcClient, sessionId: string) {
    if (eventUnsubRef.current) {
      eventUnsubRef.current();
      eventUnsubRef.current = null;
    }

    const abort = new AbortController();
    (async () => {
      try {
        const iter = await client.agent.onEvents({ sessionId });
        for await (const event of iter) {
          if (abort.signal.aborted) break;
          onEvent(event as AgentEvent);
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          setState((prev) => ({ ...prev, error: wrapError(err) }));
        }
      }
    })();

    eventUnsubRef.current = () => abort.abort();
  }

  function subscribeToWorkspaceEvents(client: RpcClient, workerId: string, workspaceId: string) {
    if (workspaceEventUnsubRef.current) {
      workspaceEventUnsubRef.current();
      workspaceEventUnsubRef.current = null;
    }

    const abort = new AbortController();
    (async () => {
      try {
        const iter = await client.workspace.onEvents({ workerId, workspaceId });
        for await (const event of iter) {
          if (abort.signal.aborted) break;
          const wsEvent = event as WorkspaceEvent;
          if (wsEvent.type === "config_changed") {
            setState((prev) => ({ ...prev, currentModel: wsEvent.config.model ?? null }));
          } else if (wsEvent.type === "cron_fired") {
            if (wsEvent.targetSessionId !== sessionIdRef.current) {
              setState((prev) => ({
                ...prev,
                cronNotification: {
                  jobName: wsEvent.jobName,
                  targetSessionId: wsEvent.targetSessionId,
                  ...(wsEvent.error ? { error: wsEvent.error } : {}),
                },
              }));
            }
          }
        }
      } catch {
        // Non-fatal: workspace events are supplementary
      }
    })();

    workspaceEventUnsubRef.current = () => abort.abort();
  }

  function onEvent(event: AgentEvent) {
    setState((prev) => handleEvent(prev, event));
  }

  const sendMessage = useCallback((text: string) => {
    const validation = validateSendPreconditions(
      text,
      clientRef.current !== null,
      sessionIdRef.current !== null,
    );
    if (!validation.ok) {
      if (validation.reason === "error")
        setState((prev) => ({ ...prev, error: validation.error }));
      return;
    }

    const client = clientRef.current!;
    const sessionId = sessionIdRef.current!;

    const userMessage = createUserMessage(text);

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      error: null,
      cronNotification: null,
    }));

    client.agent.prompt({ sessionId, text })
      .catch((err) => {
        setState((prev) => ({ ...prev, error: wrapError(err) }));
      });
  }, []);

  const executeShell = useCallback((command: string, saveToSession?: boolean) => {
    if (!clientRef.current || !sessionIdRef.current) {
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, createSystemMessage("No worker connected")],
      }));
      return;
    }

    const client = clientRef.current;
    const sessionId = sessionIdRef.current;

    setState((prev) => ({ ...prev, isShellRunning: true }));

    client.agent.shellExec({ sessionId, command, saveToSession })
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
    const client = clientRef.current;
    const sessionId = sessionIdRef.current;
    if (!client || !sessionId) return;

    client.agent.abort({ sessionId }).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    setState(createResetState(state.connected, state.sessionId, state.workerId, state.workerName, state.workspaceId, state.workspaceName));
  }, [state.connected, state.sessionId, state.workerId, state.workerName, state.workspaceId, state.workspaceName]);

  const approveToolCall = useCallback((approvalId: string) => {
    const client = clientRef.current;
    const sessionId = sessionIdRef.current;
    if (!client || !sessionId) return;

    client.tool.approve({ sessionId, approvalId })
      .then((result) => {
        if (result.applied) {
          setState((prev) => removeApproval(prev, approvalId));
        }
      })
      .catch(() => {});
  }, []);

  const alwaysApproveToolCall = useCallback((approvalId: string) => {
    const client = clientRef.current;
    const sessionId = sessionIdRef.current;
    if (!client || !sessionId) return;

    client.tool.approve({ sessionId, approvalId, always: true })
      .then((result) => {
        if (result.applied) {
          setState((prev) => removeApproval(prev, approvalId));
        }
      })
      .catch(() => {});
  }, []);

  const denyToolCall = useCallback((approvalId: string, feedback?: string) => {
    const client = clientRef.current;
    const sessionId = sessionIdRef.current;
    if (!client || !sessionId) return;

    client.tool.deny({ sessionId, approvalId, ...(feedback ? { feedback } : {}) })
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
    const client = clientRef.current;
    if (!client) return [];
    const wid = workerIdRef.current;
    const { sessions } = await client.session.list(wid ? { workerId: wid } : undefined);
    return sessions;
  }, []);

  const switchSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current;
    if (!client) return;

    try {
      const loaded = await client.session.load({ sessionId });
      sessionIdRef.current = loaded.sessionId;
      workerIdRef.current = loaded.workerId;

      const { workers } = await client.agent.list();
      const workerName = workers.find((w) => w.workerId === loaded.workerId)?.name ?? null;

      setState((prev) => ({
        ...createResetState(prev.connected, loaded.sessionId, loaded.workerId, workerName, prev.workspaceId, prev.workspaceName),
        messages: loaded.messages as any[],
      }));

      subscribeToEvents(client, loaded.sessionId);
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const newSession = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;

    try {
      let workerId = workerIdRef.current;
      let workerName: string | null = null;
      if (!workerId) {
        const { workers } = await client.agent.list();
        const result = selectWorker(workers, "No workers connected.");
        if ("error" in result) {
          setState((prev) => ({ ...prev, error: result.error }));
          return;
        }
        workerId = result.workerId;
        workerIdRef.current = workerId;
        workerName = workers.find((w) => w.workerId === workerId)?.name ?? null;
      }

      let workspaceId = workspaceIdRef.current;
      if (!workspaceId) {
        const { workspace } = await client.workspace.ensureDefault({ workerId });
        workspaceId = workspace.id;
        workspaceIdRef.current = workspaceId;
      }

      const created = await client.session.create({ workerId, workspaceId });
      sessionIdRef.current = created.sessionId;

      setState((prev) => createResetState(prev.connected, created.sessionId, workerId, workerName ?? prev.workerName, workspaceId, prev.workspaceName));

      subscribeToEvents(client, created.sessionId);
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const renameSession = useCallback(async (name: string) => {
    const client = clientRef.current;
    const sessionId = sessionIdRef.current;
    if (!client || !sessionId) return;

    try {
      await client.session.rename({ sessionId, name });
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const listWorkers = useCallback(async (): Promise<WorkerInfo[]> => {
    const client = clientRef.current;
    if (!client) return [];
    const { workers } = await client.agent.list();
    return workers as WorkerInfo[];
  }, []);

  const switchWorker = useCallback(async (newWorkerId: string) => {
    const client = clientRef.current;
    if (!client) return;

    const { workers } = await client.agent.list();
    const result = selectWorkerById(workers, newWorkerId);
    if ("error" in result) {
      setState((prev) => ({ ...prev, error: result.error }));
      return;
    }

    workerIdRef.current = newWorkerId;

    const { workspace, sessionId } = await client.workspace.ensureDefault({ workerId: newWorkerId });
    workspaceIdRef.current = workspace.id;

    const wsModel = workspace.config.model ?? null;
    try {
      const loaded = await client.session.load({ sessionId });
      sessionIdRef.current = loaded.sessionId;
      setState((prev) => ({
        ...createResetState(prev.connected, loaded.sessionId, newWorkerId, result.name, workspace.id, workspace.name),
        messages: loaded.messages as any[],
        currentModel: wsModel,
      }));
      subscribeToEvents(client, loaded.sessionId);
    } catch {
      const created = await client.session.create({ workerId: newWorkerId, workspaceId: workspace.id });
      sessionIdRef.current = created.sessionId;
      setState((prev) => ({
        ...createResetState(prev.connected, created.sessionId, newWorkerId, result.name, workspace.id, workspace.name),
        currentModel: wsModel,
      }));
      subscribeToEvents(client, created.sessionId);
    }

    subscribeToWorkspaceEvents(client, newWorkerId, workspace.id);
  }, []);

  const listModels = useCallback(async (): Promise<ModelInfo[]> => {
    const client = clientRef.current;
    if (!client) return [];
    const { models } = await client.provider.listModels({});
    return models as ModelInfo[];
  }, []);

  const setModel = useCallback(async (modelId: string | null) => {
    const client = clientRef.current;
    const workerId = workerIdRef.current;
    const workspaceId = workspaceIdRef.current;
    if (!client || !workerId || !workspaceId) return;

    const config = modelId ? { model: modelId } : {};
    await client.workspace.setConfig({ workerId, workspaceId, config });
    setState((prev) => ({ ...prev, currentModel: modelId }));
  }, []);

  const listWorkspaces = useCallback(async (): Promise<Workspace[]> => {
    const client = clientRef.current;
    const workerId = workerIdRef.current;
    if (!client || !workerId) return [];
    return client.workspace.list({ workerId });
  }, []);

  const listWorkspaceSessions = useCallback(async (workspaceId: string): Promise<WorkspaceSessionInfo[]> => {
    const client = clientRef.current;
    const workerId = workerIdRef.current;
    if (!client || !workerId) return [];
    return client.workspace.sessions({ workerId, workspaceId });
  }, []);

  const switchWorkspace = useCallback(async (workspaceId: string, sessionId?: string) => {
    const client = clientRef.current;
    const workerId = workerIdRef.current;
    if (!client || !workerId) return;

    try {
      const workspaces = await client.workspace.list({ workerId });
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace) {
        setState((prev) => ({ ...prev, error: new Error("Workspace not found") }));
        return;
      }
      workspaceIdRef.current = workspace.id;

      const targetSessionId = sessionId ?? workspace.lastSessionId;
      const loaded = await client.session.load({ sessionId: targetSessionId });
      sessionIdRef.current = loaded.sessionId;

      setState((prev) => ({
        ...createResetState(prev.connected, loaded.sessionId, workerId, prev.workerName, workspace.id, workspace.name),
        messages: loaded.messages as any[],
        currentModel: workspace.config.model ?? null,
      }));

      subscribeToEvents(client, loaded.sessionId);
      subscribeToWorkspaceEvents(client, workerId, workspace.id);
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const createWorkspace = useCallback(async (name: string) => {
    const client = clientRef.current;
    const workerId = workerIdRef.current;
    if (!client || !workerId) return;

    try {
      const { workspace, sessionId } = await client.workspace.create({ workerId, name });
      workspaceIdRef.current = workspace.id;
      sessionIdRef.current = sessionId;

      setState((prev) =>
        createResetState(prev.connected, sessionId, workerId, prev.workerName, workspace.id, workspace.name),
      );

      subscribeToEvents(client, sessionId);
      subscribeToWorkspaceEvents(client, workerId, workspace.id);
    } catch (err) {
      setState((prev) => ({ ...prev, error: wrapError(err) }));
    }
  }, []);

  const createPairingCode = useCallback(async (name: string): Promise<{ code: string }> => {
    const client = clientRef.current;
    if (!client) throw new Error("Not connected");
    return client.auth.createPairingCode({ name });
  }, []);

  const listApiKeys = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return [];
    return client.auth.listApiKeys();
  }, []);

  const revokeApiKey = useCallback(async (id: string) => {
    const client = clientRef.current;
    if (!client) throw new Error("Not connected");
    return client.auth.revokeApiKey({ id });
  }, []);

  const renameWorkspace = useCallback(async (name: string, workspaceId?: string) => {
    const client = clientRef.current;
    const workerId = workerIdRef.current;
    const wsId = workspaceId ?? workspaceIdRef.current;
    if (!client || !workerId || !wsId) return;

    try {
      await client.workspace.rename({ workerId, workspaceId: wsId, name });
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
