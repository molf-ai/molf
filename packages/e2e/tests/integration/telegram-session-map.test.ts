import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  type TestServer,
  type TestWorker,
} from "../../helpers/index.js";
import { SessionMap } from "../../../client-telegram/src/session-map.js";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "telegram-sessionmap-worker", {
    echo: {
      description: "Echo the input text back",
      execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "default" }) }),
    },
    greet: {
      description: "Greet a person by name",
      execute: async (args: any) => ({ output: `Hello, ${args.name}!` }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Telegram client integration: SessionMap", () => {
  test("creates sessions on the real server", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(client, worker.workerId);

      const sessionId = await sessionMap.getOrCreate(12345);
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe("string");

      // Verify session exists on server
      const loaded = await client.session.load({ sessionId });
      expect(loaded.sessionId).toBe(sessionId);
    } finally {
      ws.close();
    }
  });

  test("reuses existing session for same chat", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(client, worker.workerId);

      const id1 = await sessionMap.getOrCreate(100);
      const id2 = await sessionMap.getOrCreate(100);
      expect(id1).toBe(id2);
    } finally {
      ws.close();
    }
  });

  test("creates separate sessions for different chats", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(client, worker.workerId);

      const id1 = await sessionMap.getOrCreate(200);
      const id2 = await sessionMap.getOrCreate(201);
      expect(id1).not.toBe(id2);
    } finally {
      ws.close();
    }
  });

  test("createNew replaces session and creates new one on server", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(client, worker.workerId);

      const original = await sessionMap.getOrCreate(300);
      const replacement = await sessionMap.createNew(300);

      expect(replacement).not.toBe(original);
      expect(sessionMap.get(300)).toBe(replacement);

      // Both sessions should exist on server
      const loadedOriginal = await client.session.load({ sessionId: original });
      const loadedReplacement = await client.session.load({ sessionId: replacement });
      expect(loadedOriginal.sessionId).toBe(original);
      expect(loadedReplacement.sessionId).toBe(replacement);
    } finally {
      ws.close();
    }
  });

  test("sessions appear in server listing", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(client, worker.workerId);
      const sessionId = await sessionMap.getOrCreate(400);

      const listed = await client.session.list({});
      const found = listed.sessions.find((s) => s.sessionId === sessionId);
      expect(found).toBeTruthy();
    } finally {
      ws.close();
    }
  });
});
