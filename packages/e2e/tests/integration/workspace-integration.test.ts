import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  clearWsIdCache,
  type TestServer,
  type TestWorker,
} from "../../helpers/index.js";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "workspace-integration-worker");
});

afterAll(() => {
  clearWsIdCache();
  worker.cleanup();
  server.cleanup();
});

describe("Workspace integration", () => {
  test("workspace.create creates workspace with session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.client.workspace.create({
        workerId: worker.workerId,
        name: "create-test",
      });

      expect(result.workspace).toBeTruthy();
      expect(result.workspace.id).toBeTruthy();
      expect(result.sessionId).toBeTruthy();

      // Load the session to confirm it exists
      const loaded = await client.client.session.load({
        sessionId: result.sessionId,
      });
      expect(loaded).toBeTruthy();
      expect(loaded.sessionId).toBe(result.sessionId);
    } finally {
      client.cleanup();
    }
  });

  test("workspace.sessions returns sessions sorted with last active first", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.client.workspace.create({
        workerId: worker.workerId,
        name: "sessions-sort-test",
      });
      const wsId = created.workspace.id;

      // Create additional sessions in the same workspace
      const session2 = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: wsId,
        name: "second-session",
      });
      const session3 = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: wsId,
        name: "third-session",
      });

      const sessions = await client.client.workspace.sessions({
        workerId: worker.workerId,
        workspaceId: wsId,
      });

      expect(sessions.length).toBe(3);
      // Most recently created/active session should come first
      expect(sessions[0].sessionId).toBe(session3.sessionId);
      expect(sessions[1].sessionId).toBe(session2.sessionId);
      expect(sessions[2].sessionId).toBe(created.sessionId);
    } finally {
      client.cleanup();
    }
  });

  test("workspace.rename changes workspace name", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.client.workspace.create({
        workerId: worker.workerId,
        name: "rename-before",
      });

      const result = await client.client.workspace.rename({
        workerId: worker.workerId,
        workspaceId: created.workspace.id,
        name: "rename-after",
      });
      expect(result.success).toBe(true);

      const workspaces = await client.client.workspace.list({
        workerId: worker.workerId,
      });
      const found = workspaces.find((w) => w.id === created.workspace.id);
      expect(found).toBeTruthy();
      expect(found!.name).toBe("rename-after");
    } finally {
      client.cleanup();
    }
  });

  test("workspace.setConfig with model override", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.client.workspace.create({
        workerId: worker.workerId,
        name: "config-override-test",
      });

      const result = await client.client.workspace.setConfig({
        workerId: worker.workerId,
        workspaceId: created.workspace.id,
        config: { model: "gemini/test" },
      });
      expect(result.success).toBe(true);
    } finally {
      client.cleanup();
    }
  });

  test("workspace.list returns all workspaces for worker", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const workspaces = await client.client.workspace.list({
        workerId: worker.workerId,
      });

      // Should contain at least the default workspace created on worker connect
      expect(workspaces.length).toBeGreaterThanOrEqual(1);
      const defaultWs = workspaces.find((w) => w.isDefault);
      expect(defaultWs).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("workspace.ensureDefault is idempotent", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const first = await client.client.workspace.ensureDefault({
        workerId: worker.workerId,
      });
      const second = await client.client.workspace.ensureDefault({
        workerId: worker.workerId,
      });

      expect(first.workspace.id).toBe(second.workspace.id);
    } finally {
      client.cleanup();
    }
  });
});
