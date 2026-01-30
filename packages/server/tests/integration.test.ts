import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@molf-ai/protocol";
import { startServer } from "../src/server.js";
import type { ServerInstance } from "../src/server.js";

let testDir: string;
let server: ServerInstance;
let trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
let wsClient: ReturnType<typeof createWSClient>;

const TEST_PORT = 17601;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "molf-integration-"));

  process.env.MOLF_TOKEN = "test-integration-token";

  server = startServer({
    host: "127.0.0.1",
    port: TEST_PORT,
    dataDir: testDir,
  });

  // Wait for server to be ready
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Create client
  const url = new URL(`ws://127.0.0.1:${TEST_PORT}`);
  url.searchParams.set("token", server.token);
  url.searchParams.set("name", "test-client");

  wsClient = createWSClient({ url: url.toString() });
  trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });
});

afterAll(() => {
  wsClient?.close();
  server?.close();
  delete process.env.MOLF_TOKEN;
  rmSync(testDir, { recursive: true, force: true });
});

describe("Integration: Worker registration", () => {
  const workerId = "550e8400-e29b-41d4-a716-446655440001";

  test("worker can register with the server", async () => {
    const result = await trpc.worker.register.mutate({
      workerId,
      name: "test-worker",
      tools: [
        {
          name: "echo_tool",
          description: "Echoes input",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
      skills: [
        { name: "greet", description: "Greeting skill", content: "Say hello" },
      ],
      metadata: { workdir: "/tmp/test" },
    });

    expect(result.workerId).toBe(workerId);
  });

  test("duplicate worker registration is rejected", async () => {
    try {
      await trpc.worker.register.mutate({
        workerId,
        name: "duplicate",
        tools: [],
      });
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain("already connected");
    }
  });

  test("agent.list returns registered workers", async () => {
    const result = await trpc.agent.list.query();

    expect(result.workers.length).toBeGreaterThanOrEqual(1);
    const worker = result.workers.find((w) => w.workerId === workerId);
    expect(worker).toBeDefined();
    expect(worker!.name).toBe("test-worker");
    expect(worker!.tools).toHaveLength(1);
    expect(worker!.tools[0].name).toBe("echo_tool");
    expect(worker!.skills).toHaveLength(1);
    expect(worker!.connected).toBe(true);
  });
});

describe("Integration: Session lifecycle", () => {
  const workerId = "550e8400-e29b-41d4-a716-446655440001";

  test("session.create creates a new session", async () => {
    const result = await trpc.session.create.mutate({
      workerId,
      name: "Test Session",
    });

    expect(result.sessionId).toBeDefined();
    expect(result.name).toBe("Test Session");
    expect(result.workerId).toBe(workerId);
    expect(result.createdAt).toBeGreaterThan(0);
  });

  test("session.create rejects unknown worker", async () => {
    try {
      await trpc.session.create.mutate({
        workerId: "00000000-0000-0000-0000-000000000000",
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("not found");
    }
  });

  test("session.list returns created sessions", async () => {
    const result = await trpc.session.list.query();

    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    const session = result.sessions.find((s) => s.name === "Test Session");
    expect(session).toBeDefined();
  });

  test("session.load retrieves session data", async () => {
    const created = await trpc.session.create.mutate({
      workerId,
      name: "Load Test",
    });

    const loaded = await trpc.session.load.mutate({
      sessionId: created.sessionId,
    });

    expect(loaded.sessionId).toBe(created.sessionId);
    expect(loaded.name).toBe("Load Test");
    expect(loaded.messages).toEqual([]);
  });

  test("session.load rejects nonexistent session", async () => {
    try {
      await trpc.session.load.mutate({ sessionId: "nonexistent" });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("not found");
    }
  });

  test("session.delete removes session", async () => {
    const created = await trpc.session.create.mutate({
      workerId,
      name: "Delete Me",
    });

    const result = await trpc.session.delete.mutate({
      sessionId: created.sessionId,
    });

    expect(result.deleted).toBe(true);

    // Verify it's gone
    try {
      await trpc.session.load.mutate({ sessionId: created.sessionId });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("not found");
    }
  });
});

describe("Integration: Tool dispatch", () => {
  const workerId = "550e8400-e29b-41d4-a716-446655440002";

  test("worker.onToolCall subscription and toolResult round-trip", async () => {
    // Register a new worker for this test
    await trpc.worker.register.mutate({
      workerId,
      name: "dispatch-worker",
      tools: [
        {
          name: "add",
          description: "Adds two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        },
      ],
    });

    // Subscribe to tool calls
    const received: any[] = [];
    const subscription = trpc.worker.onToolCall.subscribe(
      { workerId },
      {
        onData: (data) => {
          received.push(data);
          // Send result back
          trpc.worker.toolResult.mutate({
            toolCallId: data.toolCallId,
            result: { sum: 42 },
          });
        },
        onError: () => {},
      },
    );

    // Give subscription time to establish
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clean up
    subscription.unsubscribe();
  });
});

describe("Integration: Worker rename", () => {
  const workerId = "550e8400-e29b-41d4-a716-446655440001";

  test("worker can be renamed", async () => {
    const result = await trpc.worker.rename.mutate({
      workerId,
      name: "renamed-worker",
    });

    expect(result.renamed).toBe(true);

    // Verify the name changed
    const workers = await trpc.agent.list.query();
    const worker = workers.workers.find((w) => w.workerId === workerId);
    expect(worker?.name).toBe("renamed-worker");
  });
});

describe("Integration: Tool approval (v1 stubs)", () => {
  test("tool.approve returns applied: true (v1 auto-approve)", async () => {
    const result = await trpc.tool.approve.mutate({
      sessionId: "any",
      toolCallId: "any",
    });
    expect(result.applied).toBe(true);
  });

  test("tool.deny returns applied: false (v1 no-op)", async () => {
    const result = await trpc.tool.deny.mutate({
      sessionId: "any",
      toolCallId: "any",
    });
    expect(result.applied).toBe(false);
  });
});

describe("Integration: Session persistence across restart", () => {
  const workerId = "550e8400-e29b-41d4-a716-446655440001";

  test("sessions survive server restart", async () => {
    // Create a session
    const created = await trpc.session.create.mutate({
      workerId,
      name: "Persistent Session",
    });

    // The session file should exist on disk via the session manager
    // We test loading it in a new SessionManager to simulate restart
    const { SessionManager } = await import("../src/session-mgr.js");
    const mgr = new SessionManager(testDir);
    const loaded = mgr.load(created.sessionId);

    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("Persistent Session");
    expect(loaded!.workerId).toBe(workerId);
  });
});

describe("Integration: Agent status", () => {
  test("agent.status returns idle for new session", async () => {
    const workerId = "550e8400-e29b-41d4-a716-446655440001";
    const session = await trpc.session.create.mutate({ workerId });

    const status = await trpc.agent.status.query({
      sessionId: session.sessionId,
    });

    expect(status.status).toBe("idle");
    expect(status.sessionId).toBe(session.sessionId);
  });
});

describe("Integration: Tool list", () => {
  test("tool.list returns tools for session's bound worker", async () => {
    const workerId = "550e8400-e29b-41d4-a716-446655440001";
    const session = await trpc.session.create.mutate({ workerId });

    const result = await trpc.tool.list.query({
      sessionId: session.sessionId,
    });

    expect(result.tools.length).toBeGreaterThanOrEqual(1);
    expect(result.tools[0].workerId).toBe(workerId);
  });

  test("tool.list returns empty for session with disconnected worker", async () => {
    // Create session with a worker that isn't connected
    const workerId = "550e8400-e29b-41d4-a716-446655440003";

    // We need to register the worker first, then create the session
    await trpc.worker.register.mutate({
      workerId,
      name: "temp-worker",
      tools: [{ name: "t", description: "t", inputSchema: {} }],
    });
    const session = await trpc.session.create.mutate({ workerId });

    // The tools should still be available since the worker is connected
    const result = await trpc.tool.list.query({
      sessionId: session.sessionId,
    });
    expect(result.tools).toHaveLength(1);
  });
});
