import { useState, useEffect, useCallback, useRef } from "react";
import {
  Agent,
  type AgentConfig,
  type AgentStatus,
  type AgentEvent,
  type SessionMessage,
  type Tool,
} from "@molf-ai/agent-core";
import type { ToolCallInfo, CompletedToolCallGroup } from "../types.js";

interface UseAgentState {
  messages: SessionMessage[];
  status: AgentStatus;
  streamingContent: string;
  activeToolCalls: ToolCallInfo[];
  completedToolCalls: CompletedToolCallGroup[];
  error: Error | null;
}

interface UseAgentReturn extends UseAgentState {
  sendMessage: (text: string) => void;
  abort: () => void;
  reset: () => void;
}

export function useAgent(
  configOverrides?: Partial<{
    llm: Partial<AgentConfig["llm"]>;
    behavior: Partial<AgentConfig["behavior"]>;
  }>,
  tools?: Tool[],
): UseAgentReturn {
  const agentRef = useRef<Agent | null>(null);

  const [state, setState] = useState<UseAgentState>({
    messages: [],
    status: "idle",
    streamingContent: "",
    activeToolCalls: [],
    completedToolCalls: [],
    error: null,
  });

  // Initialize agent once
  useEffect(() => {
    const agent = new Agent(configOverrides);

    if (tools) {
      for (const tool of tools) {
        agent.registerTool(tool);
      }
    }

    const unsub = agent.onEvent((event: AgentEvent) => {
      switch (event.type) {
        case "status_change":
          setState((prev) => ({
            ...prev,
            status: event.status,
            // Clear streaming content when going idle
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
          setState((prev) => {
            const updatedMessages = [...agent.getSession().getMessages()];
            const lastMsg = updatedMessages[updatedMessages.length - 1];
            return {
              ...prev,
              messages: updatedMessages,
              streamingContent: "",
              activeToolCalls: [],
              completedToolCalls:
                prev.activeToolCalls.length > 0
                  ? [
                      ...prev.completedToolCalls,
                      {
                        assistantMessageId: lastMsg?.id ?? "",
                        toolCalls: [...prev.activeToolCalls],
                      },
                    ]
                  : prev.completedToolCalls,
            };
          });
          break;

        case "error":
          setState((prev) => ({
            ...prev,
            error: event.error,
          }));
          break;
      }
    });

    agentRef.current = agent;

    return () => {
      unsub();
      agentRef.current = null;
    };
  }, []); // Intentionally run once on mount

  const sendMessage = useCallback((text: string) => {
    const agent = agentRef.current;
    if (!agent || text.trim() === "") return;

    // Optimistically add user message to display
    setState((prev) => ({
      ...prev,
      messages: [...agent.getSession().getMessages(), {
        id: `pending_${Date.now()}`,
        role: "user" as const,
        content: text,
        timestamp: Date.now(),
      }],
      error: null,
    }));

    agent.prompt(text).catch((err) => {
      // Error already handled via event
    });
  }, []);

  const abort = useCallback(() => {
    agentRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    agentRef.current?.resetSession();
    setState({
      messages: [],
      status: "idle",
      streamingContent: "",
      activeToolCalls: [],
      completedToolCalls: [],
      error: null,
    });
  }, []);

  return {
    ...state,
    sendMessage,
    abort,
    reset,
  };
}
