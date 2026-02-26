import { describe, test, expect } from "bun:test";
import {
  createInitialState,
  handleEvent,
  createResetState,
  applySessionLoaded,
  removeApproval,
  type UseServerState,
} from "../src/hooks/event-reducer.js";
import {
  wrapError,
  createUserMessage,
  validateSendPreconditions,
  selectWorker,
  selectWorkerById,
  createSystemMessage,
} from "../src/hooks/session-actions.js";
import type { AgentEvent } from "@molf-ai/protocol";

function baseState(overrides?: Partial<UseServerState>): UseServerState {
  return {
    ...createInitialState({}),
    ...overrides,
  };
}

describe("createInitialState", () => {
  test("initial state has connected=false, messages=[], status=idle", () => {
    const state = createInitialState({});
    expect(state.connected).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.status).toBe("idle");
    expect(state.streamingContent).toBe("");
    expect(state.activeToolCalls).toEqual([]);
    expect(state.completedToolCalls).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.sessionId).toBeNull();
    expect(state.pendingApprovals).toEqual([]);
  });

  test("initial state with sessionId", () => {
    const state = createInitialState({ sessionId: "s1" });
    expect(state.sessionId).toBe("s1");
  });
});

describe("handleEvent state machine", () => {
  test("status_change updates status", () => {
    const prev = baseState();
    const event: AgentEvent = { type: "status_change", status: "streaming" };
    const next = handleEvent(prev, event);
    expect(next.status).toBe("streaming");
  });

  test("status_change to idle clears streamingContent", () => {
    const prev = baseState({ status: "streaming", streamingContent: "partial" });
    const event: AgentEvent = { type: "status_change", status: "idle" };
    const next = handleEvent(prev, event);
    expect(next.status).toBe("idle");
    expect(next.streamingContent).toBe("");
  });

  test("status_change to streaming does not clear streamingContent", () => {
    const prev = baseState({ streamingContent: "existing" });
    const event: AgentEvent = { type: "status_change", status: "streaming" };
    const next = handleEvent(prev, event);
    expect(next.streamingContent).toBe("existing");
  });

  test("content_delta updates streamingContent", () => {
    const prev = baseState();
    const event: AgentEvent = {
      type: "content_delta",
      delta: "Hello",
      content: "Hello",
    };
    const next = handleEvent(prev, event);
    expect(next.streamingContent).toBe("Hello");
  });

  test("tool_call_start adds to activeToolCalls", () => {
    const prev = baseState();
    const event: AgentEvent = {
      type: "tool_call_start",
      toolCallId: "tc1",
      toolName: "echo",
      arguments: '{"text":"hi"}',
    };
    const next = handleEvent(prev, event);
    expect(next.activeToolCalls).toHaveLength(1);
    expect(next.activeToolCalls[0].toolCallId).toBe("tc1");
    expect(next.activeToolCalls[0].toolName).toBe("echo");
    expect(next.activeToolCalls[0].arguments).toBe('{"text":"hi"}');
  });

  test("tool_call_end updates matching tool call with result", () => {
    const prev = baseState({
      activeToolCalls: [
        { toolCallId: "tc1", toolName: "echo", arguments: '{"text":"hi"}' },
        { toolCallId: "tc2", toolName: "read", arguments: '{"path":"/"}' },
      ],
    });
    const event: AgentEvent = {
      type: "tool_call_end",
      toolCallId: "tc1",
      toolName: "echo",
      result: "hi back",
    };
    const next = handleEvent(prev, event);
    expect(next.activeToolCalls[0].result).toBe("hi back");
    expect(next.activeToolCalls[1].result).toBeUndefined();
  });

  test("turn_complete adds message, clears streaming and active tool calls", () => {
    const prev = baseState({
      streamingContent: "partial",
      activeToolCalls: [],
    });
    const msg = {
      id: "m1",
      role: "assistant" as const,
      content: "done",
      timestamp: 1000,
    };
    const event: AgentEvent = { type: "turn_complete", message: msg };
    const next = handleEvent(prev, event);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].id).toBe("m1");
    expect(next.streamingContent).toBe("");
    expect(next.activeToolCalls).toEqual([]);
  });

  test("turn_complete groups completed tool calls", () => {
    const prev = baseState({
      activeToolCalls: [
        { toolCallId: "tc1", toolName: "echo", arguments: "{}", result: "ok" },
      ],
      completedToolCalls: [],
    });
    const msg = {
      id: "m1",
      role: "assistant" as const,
      content: "done",
      timestamp: 1000,
    };
    const event: AgentEvent = { type: "turn_complete", message: msg };
    const next = handleEvent(prev, event);
    expect(next.completedToolCalls).toHaveLength(1);
    expect(next.completedToolCalls[0].assistantMessageId).toBe("m1");
    expect(next.completedToolCalls[0].toolCalls).toHaveLength(1);
    expect(next.completedToolCalls[0].toolCalls[0].toolCallId).toBe("tc1");
    expect(next.activeToolCalls).toEqual([]);
  });

  test("turn_complete with no active tool calls does not add to completedToolCalls", () => {
    const prev = baseState({ activeToolCalls: [], completedToolCalls: [] });
    const msg = {
      id: "m1",
      role: "assistant" as const,
      content: "done",
      timestamp: 1000,
    };
    const event: AgentEvent = { type: "turn_complete", message: msg };
    const next = handleEvent(prev, event);
    expect(next.completedToolCalls).toEqual([]);
  });

  test("error sets error state", () => {
    const prev = baseState();
    const event: AgentEvent = {
      type: "error",
      code: "AGENT_ERROR",
      message: "something went wrong",
    };
    const next = handleEvent(prev, event);
    expect(next.error).toBeInstanceOf(Error);
    expect(next.error!.message).toBe("something went wrong");
  });

  test("tool_approval_required adds to pendingApprovals", () => {
    const prev = baseState();
    const event: AgentEvent = {
      type: "tool_approval_required",
      approvalId: "tc1",
      toolName: "dangerous",
      arguments: "{}",
      sessionId: "s1",
    };
    const next = handleEvent(prev, event);
    expect(next.pendingApprovals).toHaveLength(1);
    expect(next.pendingApprovals[0].approvalId).toBe("tc1");
    expect(next.pendingApprovals[0].toolName).toBe("dangerous");
    expect(next.pendingApprovals[0].sessionId).toBe("s1");
  });
});

describe("wrapError", () => {
  test("passes through Error instances unchanged", () => {
    const err = new Error("original");
    const result = wrapError(err);
    expect(result).toBe(err);
    expect(result.message).toBe("original");
  });

  test("wraps string into Error", () => {
    const result = wrapError("something broke");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("something broke");
  });

  test("wraps non-string non-Error into Error via String()", () => {
    const result = wrapError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("42");
  });
});

describe("createResetState", () => {
  test("preserves connected and sessionId", () => {
    const state = createResetState(true, "s1");
    expect(state.connected).toBe(true);
    expect(state.sessionId).toBe("s1");
  });

  test("clears all transient fields", () => {
    const state = createResetState(false, null);
    expect(state.messages).toEqual([]);
    expect(state.status).toBe("idle");
    expect(state.streamingContent).toBe("");
    expect(state.activeToolCalls).toEqual([]);
    expect(state.completedToolCalls).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.pendingApprovals).toEqual([]);
  });

  test("handles disconnected with session", () => {
    const state = createResetState(false, "s2");
    expect(state.connected).toBe(false);
    expect(state.sessionId).toBe("s2");
    expect(state.messages).toEqual([]);
  });
});

describe("createUserMessage", () => {
  test("has role user and correct content", () => {
    const msg = createUserMessage("hello world");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello world");
  });

  test("id starts with pending_", () => {
    const msg = createUserMessage("test");
    expect(msg.id).toMatch(/^pending_\d+$/);
  });

  test("timestamp is a number close to now", () => {
    const before = Date.now();
    const msg = createUserMessage("test");
    const after = Date.now();
    expect(typeof msg.timestamp).toBe("number");
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("validateSendPreconditions", () => {
  test("returns empty reason for empty string", () => {
    const result = validateSendPreconditions("", true, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
  });

  test("returns empty reason for whitespace-only string", () => {
    const result = validateSendPreconditions("   \t\n  ", true, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
  });

  test("returns error when no session", () => {
    const result = validateSendPreconditions("hello", true, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      if (result.reason === "error") {
        expect(result.error.message).toContain("No session established");
      }
    }
  });

  test("returns error when no connection", () => {
    const result = validateSendPreconditions("hello", false, true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      if (result.reason === "error") {
        expect(result.error.message).toContain("Not connected to server");
      }
    }
  });

  test("returns ok for valid preconditions", () => {
    const result = validateSendPreconditions("hello", true, true);
    expect(result.ok).toBe(true);
  });
});

describe("removeApproval", () => {
  test("removes matching approval from list of many", () => {
    const prev = baseState({
      pendingApprovals: [
        { approvalId: "tc1", toolName: "a", arguments: "{}", sessionId: "s1" },
        { approvalId: "tc2", toolName: "b", arguments: "{}", sessionId: "s1" },
        { approvalId: "tc3", toolName: "c", arguments: "{}", sessionId: "s1" },
      ],
    });
    const next = removeApproval(prev, "tc2");
    expect(next.pendingApprovals).toHaveLength(2);
    expect(next.pendingApprovals.map((a) => a.approvalId)).toEqual(["tc1", "tc3"]);
  });

  test("returns same list when approvalId not found", () => {
    const prev = baseState({
      pendingApprovals: [
        { approvalId: "tc1", toolName: "a", arguments: "{}", sessionId: "s1" },
      ],
    });
    const next = removeApproval(prev, "nonexistent");
    expect(next.pendingApprovals).toHaveLength(1);
    expect(next.pendingApprovals[0].approvalId).toBe("tc1");
  });

  test("handles empty approval list", () => {
    const prev = baseState({ pendingApprovals: [] });
    const next = removeApproval(prev, "tc1");
    expect(next.pendingApprovals).toEqual([]);
  });

  test("removes single matching approval leaving empty list", () => {
    const prev = baseState({
      pendingApprovals: [
        { approvalId: "tc1", toolName: "a", arguments: "{}", sessionId: "s1" },
      ],
    });
    const next = removeApproval(prev, "tc1");
    expect(next.pendingApprovals).toEqual([]);
  });
});

describe("selectWorker", () => {
  test("returns error with default message for empty workers list", () => {
    const result = selectWorker([]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.message).toContain("No workers connected");
      expect(result.error.message).toContain("molf worker");
    }
  });

  test("returns error with custom message for empty workers list", () => {
    const result = selectWorker([], "Custom error message.");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.message).toBe("Custom error message.");
    }
  });

  test("returns first worker from single-element list", () => {
    const result = selectWorker([{ workerId: "w1", connected: true }]);
    expect("workerId" in result).toBe(true);
    if ("workerId" in result) {
      expect(result.workerId).toBe("w1");
    }
  });

  test("returns first worker from multi-element list", () => {
    const result = selectWorker([
      { workerId: "w1", connected: true },
      { workerId: "w2", connected: true },
      { workerId: "w3", connected: true },
    ]);
    expect("workerId" in result).toBe(true);
    if ("workerId" in result) {
      expect(result.workerId).toBe("w1");
    }
  });

  test("skips offline workers and picks first online", () => {
    const result = selectWorker([
      { workerId: "w1", connected: false },
      { workerId: "w2", connected: true },
    ]);
    expect("workerId" in result).toBe(true);
    if ("workerId" in result) {
      expect(result.workerId).toBe("w2");
    }
  });

  test("returns error when all workers are offline", () => {
    const result = selectWorker([
      { workerId: "w1", connected: false },
      { workerId: "w2", connected: false },
    ]);
    expect("error" in result).toBe(true);
  });
});

describe("createSystemMessage", () => {
  test("has role system and correct content", () => {
    const msg = createSystemMessage("Worker connected");
    expect(msg.role).toBe("system");
    expect(msg.content).toBe("Worker connected");
  });

  test("id starts with sys_", () => {
    const msg = createSystemMessage("test");
    expect(msg.id).toMatch(/^sys_\d+_[a-z0-9]+$/);
  });

  test("timestamp is a number close to now", () => {
    const before = Date.now();
    const msg = createSystemMessage("test");
    const after = Date.now();
    expect(typeof msg.timestamp).toBe("number");
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("handleEvent — default case", () => {
  test("unknown event type returns state unchanged", () => {
    const prev = baseState({ status: "streaming" });
    const unknownEvent = { type: "some_future_event" } as unknown as AgentEvent;
    const next = handleEvent(prev, unknownEvent);
    expect(next).toBe(prev);
  });
});

describe("applySessionLoaded", () => {
  test("sets connected, sessionId, and messages", () => {
    const prev = baseState();
    const messages = [
      { id: "m1", role: "user" as const, content: "hi", timestamp: 1000 },
      { id: "m2", role: "assistant" as const, content: "hello", timestamp: 1001 },
    ];
    const next = applySessionLoaded(prev, "s1", messages);
    expect(next.connected).toBe(true);
    expect(next.sessionId).toBe("s1");
    expect(next.messages).toEqual(messages);
  });

  test("preserves other state fields", () => {
    const prev = baseState({
      status: "streaming",
      streamingContent: "partial",
      error: new Error("old"),
    });
    const next = applySessionLoaded(prev, "s2", []);
    expect(next.status).toBe("streaming");
    expect(next.streamingContent).toBe("partial");
    expect(next.error).toBeInstanceOf(Error);
    expect(next.error!.message).toBe("old");
  });

  test("overwrites previous session data", () => {
    const prev = baseState({
      connected: false,
      sessionId: "old-session",
      messages: [{ id: "old", role: "user" as const, content: "old", timestamp: 500 }],
    });
    const newMsgs = [{ id: "new", role: "user" as const, content: "new", timestamp: 2000 }];
    const next = applySessionLoaded(prev, "new-session", newMsgs);
    expect(next.connected).toBe(true);
    expect(next.sessionId).toBe("new-session");
    expect(next.messages).toEqual(newMsgs);
  });

  test("sets workerId and workerName when provided", () => {
    const prev = baseState();
    const next = applySessionLoaded(prev, "s1", [], "w1", "Worker One");
    expect(next.workerId).toBe("w1");
    expect(next.workerName).toBe("Worker One");
  });

  test("preserves previous worker info when not provided", () => {
    const prev = baseState({ workerId: "w-prev", workerName: "Previous" });
    const next = applySessionLoaded(prev, "s1", []);
    expect(next.workerId).toBe("w-prev");
    expect(next.workerName).toBe("Previous");
  });
});

describe("createInitialState with worker info", () => {
  test("initial state has workerId=null and workerName=null by default", () => {
    const state = createInitialState({});
    expect(state.workerId).toBeNull();
    expect(state.workerName).toBeNull();
  });

  test("initial state with workerId", () => {
    const state = createInitialState({ workerId: "w1" });
    expect(state.workerId).toBe("w1");
    expect(state.workerName).toBeNull();
  });
});

describe("createResetState with worker info", () => {
  test("preserves workerId and workerName", () => {
    const state = createResetState(true, "s1", "w1", "Worker");
    expect(state.workerId).toBe("w1");
    expect(state.workerName).toBe("Worker");
  });

  test("defaults workerId and workerName to null", () => {
    const state = createResetState(true, "s1");
    expect(state.workerId).toBeNull();
    expect(state.workerName).toBeNull();
  });
});

describe("selectWorkerById", () => {
  test("returns worker when found", () => {
    const workers = [
      { workerId: "w1", name: "Worker One" },
      { workerId: "w2", name: "Worker Two" },
    ];
    const result = selectWorkerById(workers, "w2");
    expect("workerId" in result).toBe(true);
    if ("workerId" in result) {
      expect(result.workerId).toBe("w2");
      expect(result.name).toBe("Worker Two");
    }
  });

  test("returns error when worker not found", () => {
    const workers = [{ workerId: "w1", name: "Worker One" }];
    const result = selectWorkerById(workers, "w99");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.message).toContain("w99");
      expect(result.error.message).toContain("not found");
    }
  });

  test("returns error for empty workers list", () => {
    const result = selectWorkerById([], "w1");
    expect("error" in result).toBe(true);
  });
});
