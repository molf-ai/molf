import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  waitUntil,
  waitForPersistence,
  type TestServer,
  type TestWorker,
} from "../../helpers/index.js";
import { createMockApi } from "@molf-ai/test-utils";
import { ApprovalManager } from "../../../client-telegram/src/approval.js";
import { SessionEventDispatcher } from "../../../client-telegram/src/event-dispatcher.js";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "telegram-approval-worker", {
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

describe("Telegram client integration: ApprovalManager with real server", () => {
  test("sends inline keyboard on tool_approval_required event", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { client, ws, close: () => ws.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const approvalMgr = new ApprovalManager({
        api: api as any,
        connection,
        dispatcher,
      });

      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      approvalMgr.watchSession(2001, session.sessionId);
      await waitForPersistence(500);

      server.instance._ctx.serverBus.emit({ type: "session", sessionId: session.sessionId }, {
        type: "tool_approval_required",
        approvalId: "tc-approval-1",
        toolName: "dangerous-tool",
        arguments: '{"action":"delete_everything"}',
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("dangerous-tool")),
        3000,
        "approval message",
      );

      const approvalMsg = sentMessages.find((m) => m.text.includes("dangerous-tool"));
      expect(approvalMsg!.chatId).toBe(2001);
      expect(approvalMsg!.opts?.reply_markup).toBeDefined();

      approvalMgr.cleanup();
    } finally {
      ws.close();
    }
  });

  test("handles approve callback and edits message", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, editedMessages } = createMockApi();
    try {
      const connection = { client, ws, close: () => ws.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const approvalMgr = new ApprovalManager({
        api: api as any,
        connection,
        dispatcher,
      });

      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      approvalMgr.watchSession(2002, session.sessionId);
      await waitForPersistence(500);

      server.instance._ctx.serverBus.emit({ type: "session", sessionId: session.sessionId }, {
        type: "tool_approval_required",
        approvalId: "tc-approve-test",
        toolName: "echo",
        arguments: '{"text":"test"}',
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      // Simulate user pressing Approve
      await approvalMgr.handleCallback("cb-1", "tool_approve_tc-approve-test");

      const approvedEdit = editedMessages.find((m) => m.text.includes("Approved"));
      expect(approvedEdit).toBeTruthy();

      approvalMgr.cleanup();
    } finally {
      ws.close();
    }
  });

  test("handles deny callback and edits message", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, editedMessages } = createMockApi();
    try {
      const connection = { client, ws, close: () => ws.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const approvalMgr = new ApprovalManager({
        api: api as any,
        connection,
        dispatcher,
      });

      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      approvalMgr.watchSession(2003, session.sessionId);
      await waitForPersistence(500);

      server.instance._ctx.serverBus.emit({ type: "session", sessionId: session.sessionId }, {
        type: "tool_approval_required",
        approvalId: "tc-deny-test",
        toolName: "echo",
        arguments: '{"text":"test"}',
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      await approvalMgr.handleCallback("cb-2", "tool_deny_tc-deny-test");

      const deniedEdit = editedMessages.find((m) => m.text.includes("Denied"));
      expect(deniedEdit).toBeTruthy();

      approvalMgr.cleanup();
    } finally {
      ws.close();
    }
  });

  test("does not duplicate subscriptions", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { client, ws, close: () => ws.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const approvalMgr = new ApprovalManager({
        api: api as any,
        connection,
        dispatcher,
      });

      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      approvalMgr.watchSession(2004, session.sessionId);
      approvalMgr.watchSession(2004, session.sessionId); // duplicate
      await waitForPersistence(500);

      server.instance._ctx.serverBus.emit({ type: "session", sessionId: session.sessionId }, {
        type: "tool_approval_required",
        approvalId: "tc-dup-test",
        toolName: "echo",
        arguments: "{}",
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      const approvalMsgs = sentMessages.filter((m) => m.text.includes("echo"));
      expect(approvalMsgs.length).toBe(1);

      approvalMgr.cleanup();
    } finally {
      ws.close();
    }
  });
});
