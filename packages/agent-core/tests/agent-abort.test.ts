import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";
import type { ResolvedModel, ProviderModel } from "../src/providers/types.js";

const { Agent } = await import("../src/agent.js");

function makeResolvedModel(overrides?: Partial<ProviderModel>): ResolvedModel {
  return {
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
      variants: {},
      ...overrides,
    },
  };
}

const MODEL = makeResolvedModel();

describe("Agent abort", () => {
  test("abort during streaming sets status to aborted", async () => {
    let resolveStream: () => void;
    const waitPromise = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl((opts: any) => ({
      fullStream: (async function* () {
        // Listen for abort
        opts.abortSignal?.addEventListener("abort", () => resolveStream!());
        yield { type: "text-delta", text: "partial" };
        await waitPromise;
        // After abort, throw AbortError
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })(),
    }));

    const agent = new Agent({}, MODEL);
    const promptPromise = agent.prompt("Hi");
    // Wait a bit for stream to start
    await Bun.sleep(20);
    agent.abort();
    try {
      await promptPromise;
    } catch (e: any) {
      expect(e.name).toBe("AbortError");
    }
    expect(agent.getStatus()).toBe("aborted");
  });

  test("abort causes prompt to reject with AbortError", async () => {
    let resolveStream: () => void;
    const waitPromise = new Promise<void>((r) => (resolveStream = r));

    setStreamTextImpl((opts: any) => ({
      fullStream: (async function* () {
        opts.abortSignal?.addEventListener("abort", () => resolveStream!());
        yield { type: "text-delta", text: "partial" };
        await waitPromise;
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })(),
    }));

    const agent = new Agent({}, MODEL);
    const promptPromise = agent.prompt("Hi");
    await Bun.sleep(20);
    agent.abort();

    const err = await promptPromise.catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AbortError");
  });

  test("abort when idle does nothing", () => {
    const agent = new Agent({}, MODEL);
    const statuses: string[] = [];
    agent.onEvent((e) => {
      if (e.type === "status_change") statuses.push(e.status);
    });
    agent.abort();
    expect(statuses).toHaveLength(0);
  });

  test("after abort new prompt can be started", async () => {
    let callCount = 0;
    let resolveFirstStream: () => void;
    const firstStreamWait = new Promise<void>((r) => (resolveFirstStream = r));

    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "partial" };
            // Wait for abort signal before throwing
            opts.abortSignal?.addEventListener("abort", () => resolveFirstStream!());
            await firstStreamWait;
            const err = new Error("Aborted");
            err.name = "AbortError";
            throw err;
          })(),
        };
      }
      return mockStreamText([
        { type: "text-delta", text: "Success" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({}, MODEL);
    const p = agent.prompt("First");
    await Bun.sleep(20);
    agent.abort();
    try {
      await p;
    } catch {}

    const msg = await agent.prompt("Second");
    expect(msg.content).toBe("Success");
  });
});
