import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndWait,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

/**
 * Integration tests for system prompt building with worker metadata.
 *
 * When a worker connects with metadata (agentsDoc, workdir) and skills,
 * the system prompt passed to streamText should contain:
 * 1. Default Molf identity prompt
 * 2. agentsDoc (custom instructions)
 * 3. Skill hint (if worker has skills)
 * 4. Workdir hint (if worker has workdir metadata)
 * 5. Media hint (if worker has read_file tool)
 */
describe("System prompt building with worker metadata", () => {
  let capturedOpts: any[] = [];

  test("system prompt includes agentsDoc and workdir hint", async () => {
    capturedOpts = [];
    setStreamTextImpl((opts: any) => {
      capturedOpts.push(opts);
      return mockTextResponse("ok");
    });

    // Start a fresh server for this test
    const server = await startTestServer();

    // Use connectToServer directly to pass custom metadata (agentsDoc)
    const { connectToServer } = await import("../../../worker/src/connection.js");
    const { ToolExecutor } = await import("../../../worker/src/tool-executor.js");
    const { getOrCreateWorkerId } = await import("../../../worker/src/identity.js");
    const { createTmpDir } = await import("@molf-ai/test-utils");

    const tmp = createTmpDir("molf-sysprompt-test-");
    const workerId = getOrCreateWorkerId(tmp.path);
    const executor = new ToolExecutor(tmp.path);
    executor.registerTool({
      name: "echo",
      description: "Echo input",
      execute: async (args: any) => ({ output: args.text ?? "default" }),
    });

    const conn = await connectToServer({
      serverUrl: server.url,
      token: server.token,
      workerId,
      name: "sysprompt-worker",
      workdir: tmp.path,
      toolExecutor: executor,
      skills: [],
      metadata: {
        workdir: tmp.path,
        agentsDoc: "You are a specialized coding assistant.\nAlways use TypeScript.",
      },
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId,
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
      const systemPrompt = capturedOpts[0].system;

      // Should contain default Molf identity
      expect(systemPrompt).toContain("Molf");

      // Should contain custom agentsDoc instructions
      expect(systemPrompt).toContain("specialized coding assistant");
      expect(systemPrompt).toContain("Always use TypeScript");

      // Should contain workdir hint
      expect(systemPrompt).toContain("Your working directory is:");
      expect(systemPrompt).toContain(tmp.path);
    } finally {
      client.cleanup();
      conn.close();
      server.cleanup();
      tmp.cleanup();
    }
  });

  test("system prompt includes skill hint when worker has skills", async () => {
    capturedOpts = [];
    setStreamTextImpl((opts: any) => {
      capturedOpts.push(opts);
      return mockTextResponse("ok");
    });

    const server = await startTestServer();
    const worker = await connectTestWorker(
      server.url,
      server.token,
      "skilled-worker",
      { echo: { description: "Echo", execute: async (args: any) => ({ output: args.text }) } },
      [{ name: "deploy", description: "Deploy the app", content: "Deploy instructions here" }],
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
      const systemPrompt = capturedOpts[0].system;

      // Should contain skill hint
      expect(systemPrompt).toContain("skill");
      expect(systemPrompt).toContain("tool");
    } finally {
      client.cleanup();
      worker.cleanup();
      server.cleanup();
    }
  });

  test("system prompt includes media hint when worker has read_file tool", async () => {
    capturedOpts = [];
    setStreamTextImpl((opts: any) => {
      capturedOpts.push(opts);
      return mockTextResponse("ok");
    });

    const server = await startTestServer();
    const worker = await connectTestWorker(
      server.url,
      server.token,
      "readfile-worker",
      {
        read_file: {
          description: "Read a file",
          execute: async () => ({ output: "file contents" }),
        },
      },
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
      const systemPrompt = capturedOpts[0].system;

      // Should contain media hint about file attachments
      expect(systemPrompt).toContain("attach files");
      expect(systemPrompt).toContain(".molf/uploads/");
    } finally {
      client.cleanup();
      worker.cleanup();
      server.cleanup();
    }
  });

  test("system prompt omits media hint when worker lacks read_file tool", async () => {
    capturedOpts = [];
    setStreamTextImpl((opts: any) => {
      capturedOpts.push(opts);
      return mockTextResponse("ok");
    });

    const server = await startTestServer();
    const worker = await connectTestWorker(
      server.url,
      server.token,
      "no-readfile-worker",
      {
        echo: {
          description: "Echo input",
          execute: async (args: any) => ({ output: args.text }),
        },
      },
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      expect(capturedOpts.length).toBeGreaterThanOrEqual(1);
      const systemPrompt = capturedOpts[0].system;

      // Should NOT contain media hint
      expect(systemPrompt).not.toContain(".molf/uploads/");
    } finally {
      client.cleanup();
      worker.cleanup();
      server.cleanup();
    }
  });
});
