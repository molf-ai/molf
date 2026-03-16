import { describe, test, expect, vi } from "vitest";
import { mockTextResponse } from "@molf-ai/test-utils";
import { setStreamTextImpl, makeWorker } from "./_helpers.js";
import { buildTaskTool, buildSubagentSystemPrompt, runSubagent } from "../src/subagent-runner.js";
import { DEFAULT_AGENTS } from "../src/subagent-types.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

describe("subagent-runner unit", () => {
  describe("buildSubagentSystemPrompt", () => {
    test("includes default prompt and type suffix", () => {
      const worker = makeWorker({ agents: [] });
      const typeConfig = {
        name: "explore",
        description: "Explore",
        systemPromptSuffix: "Be read-only",
        permission: [],
        maxSteps: 10,
        source: "default" as const,
      };
      const result = buildSubagentSystemPrompt(worker, typeConfig);
      expect(result).toContain("Be read-only");
    });

    test("includes workdir hint when present", () => {
      const worker = makeWorker({
        metadata: { workdir: "/home/user/project" },
      });
      const typeConfig = {
        name: "explore",
        description: "Explore",
        systemPromptSuffix: "suffix",
        permission: [],
        maxSteps: 10,
        source: "default" as const,
      };
      const result = buildSubagentSystemPrompt(worker, typeConfig);
      expect(result).toContain("/home/user/project");
    });
  });

  describe("buildTaskTool", () => {
    test("returns null for empty agents list", () => {
      const result = buildTaskTool("s1", "w1", [], async () => ({
        sessionId: "cs1",
        result: "ok",
      }));
      expect(result).toBeNull();
    });

    test("returns tool named 'task'", () => {
      const agents = DEFAULT_AGENTS;
      const result = buildTaskTool("s1", "w1", agents, async () => ({
        sessionId: "cs1",
        result: "ok",
      }));
      expect(result).not.toBeNull();
      expect(result!.name).toBe("task");
    });

    test("tool description lists available agent types", () => {
      const agents = [
        {
          name: "explore",
          description: "Read-only explorer",
          systemPromptSuffix: "",
          permission: [],
          maxSteps: 10,
          source: "default" as const,
        },
        {
          name: "general",
          description: "General purpose",
          systemPromptSuffix: "",
          permission: [],
          maxSteps: 20,
          source: "default" as const,
        },
      ];
      const result = buildTaskTool("s1", "w1", agents, async () => ({
        sessionId: "cs1",
        result: "ok",
      }));
      expect(result!.toolDef.description).toContain('"explore"');
      expect(result!.toolDef.description).toContain('"general"');
    });

    test("tool inputSchema requires description, prompt, agentType", () => {
      const agents = DEFAULT_AGENTS;
      const result = buildTaskTool("s1", "w1", agents, async () => ({
        sessionId: "cs1",
        result: "ok",
      }));
      const schema = result!.toolDef.inputSchema;
      expect(schema.required).toContain("description");
      expect(schema.required).toContain("prompt");
      expect(schema.required).toContain("agentType");
    });

    test("execute returns task_result XML on success", async () => {
      const agents = DEFAULT_AGENTS;
      const result = buildTaskTool("s1", "w1", agents, async () => ({
        sessionId: "child1",
        result: "I found the answer",
      }));
      const output = await result!.toolDef.execute(
        { description: "find bug", prompt: "Find the bug", agentType: "explore" },
        { abortSignal: undefined },
      );
      expect(output).toContain("<task_result");
      expect(output).toContain('agent="explore"');
      expect(output).toContain('task="find bug"');
      expect(output).toContain("I found the answer");
      expect(output).toContain("</task_result>");
    });

    test("execute returns task_error XML on failure", async () => {
      const agents = DEFAULT_AGENTS;
      const result = buildTaskTool("s1", "w1", agents, async () => {
        throw new Error("Worker disconnected");
      });
      const output = await result!.toolDef.execute(
        { description: "do thing", prompt: "Do the thing", agentType: "general" },
        { abortSignal: undefined },
      );
      expect(output).toContain("<task_error");
      expect(output).toContain('agent="general"');
      expect(output).toContain("Worker disconnected");
      expect(output).toContain("</task_error>");
    });

    test("execute passes abortSignal to runSubagentFn", async () => {
      let capturedSignal: AbortSignal | undefined;
      const agents = DEFAULT_AGENTS;
      const result = buildTaskTool("s1", "w1", agents, async (params) => {
        capturedSignal = params.abortSignal;
        return { sessionId: "cs1", result: "ok" };
      });
      const ac = new AbortController();
      await result!.toolDef.execute(
        { description: "test", prompt: "test", agentType: "explore" },
        { abortSignal: ac.signal },
      );
      expect(capturedSignal).toBe(ac.signal);
    });
  });

  describe("runSubagent", () => {
    function makeDeps(overrides?: Partial<any>) {
      return {
        connectionRegistry: {
          getWorker: (id: string) => makeWorker({ id }),
        },
        sessionMgr: {
          load: () => ({ workerId: "w1", workspaceId: "ws1" }),
          create: async () => ({ sessionId: "child-session" }),
          addMessage: vi.fn(() => {}),
          save: async () => {},
          release: async () => {},
        },
        serverBus: {
          emit: vi.fn(() => {}),
          subscribe: () => () => {},
        },
        approvalGate: {
          setAgentPermission: vi.fn(() => {}),
          clearSession: vi.fn(() => {}),
        },
        buildRemoteTools: () => ({}),
        resolveModel: () => ({
          language: "mock-model" as any,
          info: {
            id: "test-model",
            providerID: "test",
            name: "Test Model",
            api: { id: "test-model", url: "", npm: "@ai-sdk/openai" },
            capabilities: {
              reasoning: false,
              toolcall: true,
              temperature: true,
              input: { text: true, image: false, pdf: false, audio: false, video: false },
              output: { text: true, image: false, pdf: false, audio: false, video: false },
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 200000, output: 8192 },
            status: "active",
            headers: {},
            options: {},
          },
        }),
        mapAgentEvent: (e: any) => e,
        ...overrides,
      };
    }

    test("throws when worker not connected", async () => {
      const deps = makeDeps({
        connectionRegistry: { getWorker: () => undefined },
      });
      await expect(
        runSubagent(
          { parentSessionId: "s1", workerId: "w1", agentType: "explore", prompt: "test" },
          deps,
        ),
      ).rejects.toThrow("Worker w1 not connected");
    });

    test("throws for unknown agent type", async () => {
      const deps = makeDeps();
      await expect(
        runSubagent(
          { parentSessionId: "s1", workerId: "w1", agentType: "nonexistent", prompt: "test" },
          deps,
        ),
      ).rejects.toThrow("Unknown agent type: nonexistent");
    });

    test("creates child session and returns result", async () => {
      setStreamTextImpl(() => mockTextResponse("subagent result text"));
      const deps = makeDeps();
      const result = await runSubagent(
        { parentSessionId: "s1", workerId: "w1", agentType: "explore", prompt: "find files" },
        deps,
      );
      expect(result.sessionId).toBe("child-session");
      expect(result.result).toBe("subagent result text");
    });

    test("sets and clears agent permissions", async () => {
      setStreamTextImpl(() => mockTextResponse("done"));
      const deps = makeDeps();
      await runSubagent(
        { parentSessionId: "s1", workerId: "w1", agentType: "explore", prompt: "test" },
        deps,
      );
      expect(deps.approvalGate.setAgentPermission).toHaveBeenCalledWith(
        "child-session",
        expect.any(Array),
      );
      expect(deps.approvalGate.clearSession).toHaveBeenCalledWith("child-session");
    });

    test("saves messages and releases session", async () => {
      setStreamTextImpl(() => mockTextResponse("done"));
      const deps = makeDeps();
      await runSubagent(
        { parentSessionId: "s1", workerId: "w1", agentType: "explore", prompt: "test" },
        deps,
      );
      expect(deps.sessionMgr.addMessage).toHaveBeenCalled();
    });
  });
});
