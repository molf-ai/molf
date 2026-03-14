import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { createEnvGuard, type EnvGuard, flushAsync } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { makeWorker, EventBus, ApprovalGate, RulesetStorage } from "./_helpers.js";
import type { AgentEvent, Attachment } from "@molf-ai/protocol";
import { buildSkillTool, buildRemoteTools, raceAbort } from "../src/tool-builder.js";
import { ToolDispatch } from "../src/tool-dispatch.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

let tmp: TmpDir;
let env: EnvGuard;
let eventBus: InstanceType<typeof EventBus>;
let approvalGate: InstanceType<typeof ApprovalGate>;
const WORKER_ID = crypto.randomUUID();

beforeAll(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");
  tmp = createTmpDir("molf-tool-builder-");
  eventBus = new EventBus();
  const rulesetStorage = new RulesetStorage(tmp.path);
  approvalGate = new ApprovalGate(rulesetStorage, eventBus);
});

afterAll(() => {
  tmp.cleanup();
  env.restore();
});

describe("raceAbort", () => {
  test("resolves normally when no signal is provided", async () => {
    await expect(raceAbort(Promise.resolve(), undefined)).resolves.toBeUndefined();
  });

  test("rejects immediately when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(raceAbort(Promise.resolve(), ac.signal)).rejects.toThrow("Aborted");
  });

  test("resolves when promise settles before abort", async () => {
    const ac = new AbortController();
    await expect(raceAbort(Promise.resolve(), ac.signal)).resolves.toBeUndefined();
    // Signal never fired — no lingering listener
  });

  test("rejects when signal fires before promise settles", async () => {
    const ac = new AbortController();
    const neverResolves = new Promise<void>(() => {});
    const p = raceAbort(neverResolves, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow("Aborted");
  });

  test("removes abort listener after promise settles", async () => {
    const ac = new AbortController();
    // Spy on removeEventListener to confirm cleanup
    let removeCalled = false;
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.removeEventListener = (...args: Parameters<typeof origRemove>) => {
      removeCalled = true;
      return origRemove(...args);
    };

    await raceAbort(Promise.resolve(), ac.signal);
    // Give microtask queue a tick for finally() to run
    await flushAsync();
    expect(removeCalled).toBe(true);
  });
});

describe("buildSkillTool", () => {
  test("with skills returns tool def", async () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy app", content: "Deploy instructions" }],
    });
    const result = buildSkillTool(worker, approvalGate, "test-session", WORKER_ID);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("skill");
  });

  test("without skills returns null", () => {
    const worker = makeWorker();
    expect(buildSkillTool(worker, approvalGate, "test-session", WORKER_ID)).toBeNull();
  });

  test("execute with unknown skill returns error after approval", async () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy", content: "..." }],
    });
    const sessionId = "skill-unknown-test";
    const result = buildSkillTool(worker, approvalGate, sessionId, WORKER_ID);

    // Skill approval defaults to "ask", so auto-approve in background
    const events: AgentEvent[] = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push(e));

    const execPromise = result!.toolDef.execute!({ name: "unknown" } as any, { toolCallId: "tc1", abortSignal: undefined } as any);

    // Wait for approval event then approve
    await new Promise<void>((resolve) => {
      const check = () => {
        const ev = events.find((e) => e.type === "tool_approval_required");
        if (ev) {
          const approvalId = (ev as any).approvalId;
          approvalGate.reply(approvalId, "once");
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    const execResult = await execPromise;
    expect((execResult as any).error).toContain("Unknown skill");
    unsub();
  });

  test("execute returns content after approval", async () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy app", content: "Deploy instructions" }],
    });
    const sessionId = "skill-approve-test";
    const result = buildSkillTool(worker, approvalGate, sessionId, WORKER_ID);

    const events: AgentEvent[] = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push(e));

    const execPromise = result!.toolDef.execute!({ name: "deploy" } as any, { toolCallId: "tc2", abortSignal: undefined } as any);

    // Wait for approval event then approve
    await new Promise<void>((resolve) => {
      const check = () => {
        const ev = events.find((e) => e.type === "tool_approval_required");
        if (ev) {
          const approvalId = (ev as any).approvalId;
          approvalGate.reply(approvalId, "once");
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    const execResult = await execPromise;
    expect((execResult as any).content).toBe("Deploy instructions");
    unsub();
  });
});

describe("buildRemoteTools", () => {
  function makeToolDispatchWithAutoResolve() {
    const td = new ToolDispatch();
    return {
      td,
      /** Resolve the next dispatched tool call with given output */
      autoResolve(output: string, extra?: { error?: string; meta?: any; attachments?: Attachment[] }) {
        // Subscribe and resolve immediately
        const ac = new AbortController();
        (async () => {
          for await (const req of td.subscribeWorker(WORKER_ID, ac.signal)) {
            td.resolveToolCall(req.toolCallId, { output, ...extra });
          }
        })();
        return () => ac.abort();
      },
    };
  }

  test("creates tools from worker.tools", () => {
    const worker = makeWorker({
      tools: [
        { name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "read_file", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      ],
    });
    const { td } = makeToolDispatchWithAutoResolve();
    const truncationMeta = new Map();
    const attachmentMeta = new Map();

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta, attachmentMeta,
    });

    expect(Object.keys(tools)).toContain("echo");
    expect(Object.keys(tools)).toContain("read_file");
  });

  test("execute dispatches to worker and returns output", async () => {
    const worker = makeWorker({
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }],
    });
    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("hello world");
    const truncationMeta = new Map();
    const attachmentMeta = new Map();

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta, attachmentMeta,
    });

    const result = await tools.echo.execute!({} as any, { toolCallId: "tc-1", abortSignal: undefined } as any);
    expect(result).toBe("hello world");
    cleanup();
  });

  test("error in dispatch result throws", async () => {
    const worker = makeWorker({
      tools: [{ name: "fail", description: "Fail", inputSchema: { type: "object", properties: {} } }],
    });
    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("", { error: "tool crashed" });
    const truncationMeta = new Map();
    const attachmentMeta = new Map();

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta, attachmentMeta,
    });

    await expect(
      tools.fail.execute!({} as any, { toolCallId: "tc-err", abortSignal: undefined } as any),
    ).rejects.toThrow("tool crashed");
    cleanup();
  });

  test("stashes truncation metadata", async () => {
    const worker = makeWorker({
      tools: [{ name: "big", description: "Big output", inputSchema: { type: "object", properties: {} } }],
    });
    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("truncated...", { meta: { truncated: true, outputId: "out-1" } });
    const truncationMeta = new Map<string, any>();
    const attachmentMeta = new Map();

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta, attachmentMeta,
    });

    await tools.big.execute!({} as any, { toolCallId: "tc-trunc", abortSignal: undefined } as any);
    expect(truncationMeta.get("tc-trunc")).toEqual({ truncated: true, outputId: "out-1" });
    cleanup();
  });

  test("stashes attachments for toModelOutput", async () => {
    const worker = makeWorker({
      tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
    });
    const att: Attachment = { mimeType: "image/png", data: new File([Buffer.from("abc")], "img.png", { type: "image/png" }), path: "/img.png", size: 100 };
    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("[Binary]", { attachments: [att] });
    const truncationMeta = new Map();
    const attachmentMeta = new Map<string, Attachment[]>();

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta, attachmentMeta,
    });

    await tools.read.execute!({} as any, { toolCallId: "tc-att", abortSignal: undefined } as any);
    expect(attachmentMeta.get("tc-att")).toHaveLength(1);
    expect(attachmentMeta.get("tc-att")![0].mimeType).toBe("image/png");
    cleanup();
  });

  test("afterExecute hook injects instructions for read_file", async () => {
    const worker = makeWorker({
      tools: [{ name: "read_file", description: "Read file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    });
    const { td, autoResolve } = makeToolDispatchWithAutoResolve();
    const cleanup = autoResolve("file content", {
      meta: { instructionFiles: [{ path: "/proj/AGENTS.md", content: "Instructions here" }] },
    });
    const truncationMeta = new Map();
    const attachmentMeta = new Map();

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: td, truncationMeta, attachmentMeta,
    }, { sessionId: "s1", loadedInstructions: new Set() });

    const result = await tools.read_file.execute!(
      { path: "/some/file" } as any,
      { toolCallId: "tc-rf", abortSignal: undefined } as any,
    );
    expect(result as string).toContain("file content");
    expect(result as string).toContain("system-reminder");
    expect(result as string).toContain("Instructions here");
    cleanup();
  });

  test("toModelOutput with attachments returns content parts", async () => {
    const worker = makeWorker({
      tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
    });
    const att: Attachment = { mimeType: "image/png", data: new File([Buffer.from("abc")], "img.png", { type: "image/png" }), path: "/img.png", size: 100 };
    const attachmentMeta = new Map<string, Attachment[]>();
    attachmentMeta.set("tc-model", [att]);

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: new ToolDispatch(), truncationMeta: new Map(), attachmentMeta,
    });

    // Call toModelOutput directly (async)
    const toolDef = tools.read as any;
    const modelOutput = await toolDef.toModelOutput({ output: "text output", toolCallId: "tc-model" });
    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value[0].text).toBe("text output");
    // Attachment part should be present
    expect(modelOutput.value.length).toBeGreaterThan(1);
  });

  test("toModelOutput without attachments returns text", async () => {
    const worker = makeWorker({
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }],
    });

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: new ToolDispatch(), truncationMeta: new Map(), attachmentMeta: new Map(),
    });

    const toolDef = tools.echo as any;
    const modelOutput = await toolDef.toModelOutput({ output: "plain text", toolCallId: "tc-plain" });
    expect(modelOutput.type).toBe("text");
    expect(modelOutput.value).toBe("plain text");
  });

  test("toModelOutput with non-string output returns json", async () => {
    const worker = makeWorker({
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }],
    });

    const tools = buildRemoteTools(worker, WORKER_ID, {
      approvalGate, toolDispatch: new ToolDispatch(), truncationMeta: new Map(), attachmentMeta: new Map(),
    });

    const toolDef = tools.echo as any;
    const modelOutput = await toolDef.toModelOutput({ output: { key: "val" }, toolCallId: "tc-json" });
    expect(modelOutput.type).toBe("json");
    expect(modelOutput.value).toEqual({ key: "val" });
  });
});
