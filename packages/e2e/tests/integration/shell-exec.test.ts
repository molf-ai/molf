import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  type TestServer,
  connectTestWorker,
  type TestWorker,
  createTestClient,
  getDefaultWsId,
  waitUntil,
} from "../../helpers/index.js";

// =============================================================================
// Integration test: agent.shellExec (! alias) end-to-end
//
// Tests the client -> server -> worker dispatch flow for shell_exec,
// bypassing the LLM prompt path entirely.
// =============================================================================

describe("agent.shellExec: successful execution", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "shell-worker", {
      shell_exec: {
        description: "Execute a shell command",
        execute: async (args: Record<string, unknown>) => {
          const command = args.command as string;

          function shellEnvelope(output: string, exitCode: number) {
            return {
              output: `${output}\n\nexit code: ${exitCode}`,
              meta: {
                truncated: false,
                exitCode,
              },
            };
          }

          // Simulate simple echo command
          if (command.startsWith("echo ")) {
            const text = command.slice(5);
            return shellEnvelope(text + "\n", 0);
          }
          // Simulate a failing command
          if (command === "false") {
            return shellEnvelope("", 1);
          }
          // Simulate command with stderr
          if (command === "warn") {
            return shellEnvelope("warning message\n", 0);
          }
          return shellEnvelope(`command not found: ${command}\n`, 127);
        },
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("executes command and returns output and exitCode", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const result = await client.trpc.agent.shellExec.mutate({
        sessionId: session.sessionId,
        command: "echo hello",
      });

      expect(result.output).toContain("hello");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);
    } finally {
      client.cleanup();
    }
  });

  test("returns non-zero exit code for failing commands", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const result = await client.trpc.agent.shellExec.mutate({
        sessionId: session.sessionId,
        command: "false",
      });

      expect(result.exitCode).toBe(1);
    } finally {
      client.cleanup();
    }
  });

  test("returns stderr output in combined output", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const result = await client.trpc.agent.shellExec.mutate({
        sessionId: session.sessionId,
        command: "warn",
      });

      expect(result.output).toContain("warning message");
      expect(result.exitCode).toBe(0);
    } finally {
      client.cleanup();
    }
  });
});

describe("agent.shellExec: error cases", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => {
    server.cleanup();
  });

  test("throws NOT_FOUND for non-existent session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      await expect(
        client.trpc.agent.shellExec.mutate({
          sessionId: "non-existent-session",
          command: "echo test",
        }),
      ).rejects.toThrow(/not found/i);
    } finally {
      client.cleanup();
    }
  });

  test("throws PRECONDITION_FAILED when worker is disconnected", async () => {
    // Connect a worker, create session, disconnect worker, then try shellExec
    const tempWorker = await connectTestWorker(
      server.url,
      server.token,
      "temp-shell-worker",
      {
        shell_exec: {
          description: "Execute a shell command",
          execute: async () => ({
            output: "\n\nexit code: 0",
            meta: {
              truncated: false,
              exitCode: 0,
            },
          }),
        },
      },
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: tempWorker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, tempWorker.workerId),
      });

      // Disconnect the worker
      tempWorker.cleanup();
      await waitUntil(
        () => !server.instance._ctx.connectionRegistry.isConnected(tempWorker.workerId),
        3000,
        "worker to disconnect",
      );

      // shellExec should fail because worker is disconnected
      await expect(
        client.trpc.agent.shellExec.mutate({
          sessionId: session.sessionId,
          command: "echo test",
        }),
      ).rejects.toThrow(/not connected|PRECONDITION_FAILED|disconnected/i);
    } finally {
      client.cleanup();
    }
  });

  test("throws PRECONDITION_FAILED when worker lacks shell_exec tool", async () => {
    // Connect a worker WITHOUT shell_exec
    const noShellWorker = await connectTestWorker(
      server.url,
      server.token,
      "no-shell-worker",
      {
        echo: {
          description: "Echo tool only",
          execute: async (args: Record<string, unknown>) => ({ output: JSON.stringify({ echoed: args.text }) }),
        },
      },
    );

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: noShellWorker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, noShellWorker.workerId),
      });

      await expect(
        client.trpc.agent.shellExec.mutate({
          sessionId: session.sessionId,
          command: "echo test",
        }),
      ).rejects.toThrow(/shell_exec|PRECONDITION_FAILED/i);
    } finally {
      client.cleanup();
      noShellWorker.cleanup();
    }
  });
});
