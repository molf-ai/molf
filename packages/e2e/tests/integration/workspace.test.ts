import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  promptAndWait,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker, TestClient } from "../../helpers/index.js";

/**
 * Workspace E2E integration tests.
 *
 * Tests the workspace lifecycle through a real server/worker/client stack:
 * - Default workspace auto-creation on worker connect
 * - CRUD operations (create, list, rename, setConfig)
 * - Session scoping within workspaces
 * - Config inheritance (workspace model → prompt uses it)
 */

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  setStreamTextImpl(() => mockTextResponse("workspace test response"));
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "ws-worker", {
    echo: {
      description: "Echo tool",
      execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "ok" }) }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Workspace lifecycle (default creation on worker connect)", () => {
  test("worker registration creates a default workspace", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const workspaces = await client.trpc.workspace.list.query({ workerId: worker.workerId });
      expect(workspaces.length).toBe(1);
      expect(workspaces[0].name).toBe("main");
      expect(workspaces[0].isDefault).toBe(true);
    } finally {
      client.cleanup();
    }
  });

  test("ensureDefault returns existing workspace on second call", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const first = await client.trpc.workspace.ensureDefault.mutate({ workerId: worker.workerId });
      const second = await client.trpc.workspace.ensureDefault.mutate({ workerId: worker.workerId });
      expect(first.workspace.id).toBe(second.workspace.id);
    } finally {
      client.cleanup();
    }
  });

  test("ensureDefault creates first session if workspace has none", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.workspace.ensureDefault.mutate({ workerId: worker.workerId });
      expect(result.sessionId).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });
});

describe("Workspace CRUD", () => {
  test("create a named workspace", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "project-alpha",
      });
      expect(result.workspace.name).toBe("project-alpha");
      expect(result.workspace.isDefault).toBe(false);
      expect(result.sessionId).toBeTruthy();

      // Verify it appears in list
      const workspaces = await client.trpc.workspace.list.query({ workerId: worker.workerId });
      const found = workspaces.find((w) => w.name === "project-alpha");
      expect(found).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("create rejects duplicate workspace name", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "dupe-test",
      });
      await expect(
        client.trpc.workspace.create.mutate({
          workerId: worker.workerId,
          name: "dupe-test",
        }),
      ).rejects.toThrow();
    } finally {
      client.cleanup();
    }
  });

  test("rename a workspace", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "before-rename",
      });
      const result = await client.trpc.workspace.rename.mutate({
        workerId: worker.workerId,
        workspaceId: created.workspace.id,
        name: "after-rename",
      });
      expect(result.success).toBe(true);

      const workspaces = await client.trpc.workspace.list.query({ workerId: worker.workerId });
      const found = workspaces.find((w) => w.id === created.workspace.id);
      expect(found!.name).toBe("after-rename");
    } finally {
      client.cleanup();
    }
  });

  test("setConfig updates workspace config", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Use a dedicated workspace so we don't contaminate the default
      const created = await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "config-update-test",
      });
      const result = await client.trpc.workspace.setConfig.mutate({
        workerId: worker.workerId,
        workspaceId: created.workspace.id,
        config: { model: "gemini/test" },
      });
      expect(result.success).toBe(true);
    } finally {
      client.cleanup();
    }
  });
});

describe("Session scoping within workspaces", () => {
  test("sessions created in a workspace appear in workspace.sessions", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "scope-test",
      });
      const wsId = created.workspace.id;

      // Create a second session in the same workspace
      await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
        name: "extra-session",
      });

      const sessions = await client.trpc.workspace.sessions.query({
        workerId: worker.workerId,
        workspaceId: wsId,
      });
      expect(sessions.length).toBe(2);
    } finally {
      client.cleanup();
    }
  });

  test("sessions in different workspaces are isolated", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const wsA = await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "isolated-a",
      });
      const wsB = await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "isolated-b",
      });

      // Each workspace.create already creates one session; add more to wsA
      await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: wsA.workspace.id,
        name: "extra-a",
      });

      const sessionsA = await client.trpc.workspace.sessions.query({
        workerId: worker.workerId,
        workspaceId: wsA.workspace.id,
      });
      const sessionsB = await client.trpc.workspace.sessions.query({
        workerId: worker.workerId,
        workspaceId: wsB.workspace.id,
      });

      expect(sessionsA.length).toBe(2);
      expect(sessionsB.length).toBe(1);
    } finally {
      client.cleanup();
    }
  });
});

describe("Prompt flow within workspace", () => {
  test("prompt in workspace session completes successfully", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const wsId = await getDefaultWsId(client.trpc, worker.workerId);
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello workspace",
      });

      // Load session and verify messages were recorded
      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });
      expect(loaded.messages.length).toBeGreaterThanOrEqual(2);
    } finally {
      client.cleanup();
    }
  });

  test("new session in workspace after clearing (simulating /clear)", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const wsId = await getDefaultWsId(client.trpc, worker.workerId);

      // First session
      const session1 = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
      });
      await promptAndWait(client.trpc, {
        sessionId: session1.sessionId,
        text: "First session message",
      });

      // Simulate /clear: create a new session in the same workspace
      const session2 = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
      });
      expect(session2.sessionId).not.toBe(session1.sessionId);

      await promptAndWait(client.trpc, {
        sessionId: session2.sessionId,
        text: "Second session message",
      });

      // Both sessions should exist in the workspace
      const sessions = await client.trpc.workspace.sessions.query({
        workerId: worker.workerId,
        workspaceId: wsId,
      });
      const ids = sessions.map((s) => s.sessionId);
      expect(ids).toContain(session1.sessionId);
      expect(ids).toContain(session2.sessionId);
    } finally {
      client.cleanup();
    }
  });
});

describe("Config inheritance", () => {
  test("workspace model config is resolved during prompt", async () => {
    // The workspace config model is checked during agent-runner.prompt().
    // We verify the flow works by creating a workspace with a model override
    // and prompting — if the model isn't found the prompt would fail.
    // Using the default model "gemini/test" which is registered in the test server.
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "config-model",
        config: { model: "gemini/test" },
      });

      await promptAndWait(client.trpc, {
        sessionId: created.sessionId,
        text: "Hello with config model",
      });

      // If we get here, the model was resolved successfully from workspace config
      const loaded = await client.trpc.session.load.mutate({
        sessionId: created.sessionId,
      });
      expect(loaded.messages.length).toBeGreaterThanOrEqual(2);
    } finally {
      client.cleanup();
    }
  });
});
