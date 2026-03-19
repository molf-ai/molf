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
  server = await startTestServer({ approval: true });
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

      // Register a real pending approval in the gate — this also emits tool_approval_required
      const approvalId = server.instance._ctx.approvalGate.requestApproval(
        "echo", { text: "test" }, ["echo"], ["echo"], session.sessionId, worker.workerId,
      );

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      // Simulate user pressing Approve using the real approvalId
      await approvalMgr.handleCallback("cb-1", `tool_approve_${approvalId}`);

      const approvedEdit = editedMessages.find((m) => m.text.includes("Approved"));
      expect(approvedEdit).toBeTruthy();

      approvalMgr.cleanup();
    } finally {
      ws.close();
    }
  });

  test("handles deny callback with two-step flow (deny → denynow)", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, editedMessages, editedMarkups } = createMockApi();
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

      // Register a real pending approval
      const approvalId = server.instance._ctx.approvalGate.requestApproval(
        "echo", { text: "test" }, ["echo"], ["echo"], session.sessionId, worker.workerId,
      );
      // Catch the rejection to avoid unhandled promise rejection
      const approvalDone = server.instance._ctx.approvalGate.waitForApproval(approvalId).catch(() => {});

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      // Step 1: "Deny" shows the two-step keyboard
      await approvalMgr.handleCallback("cb-2", `tool_deny_${approvalId}`);
      expect(editedMarkups.length).toBeGreaterThan(0);

      // Step 2: "Deny now" actually denies without reason
      await approvalMgr.handleCallback("cb-3", `tool_denynow_${approvalId}`);

      const deniedEdit = editedMessages.find((m) => m.text.includes("Denied"));
      expect(deniedEdit).toBeTruthy();

      await approvalDone;
      approvalMgr.cleanup();
    } finally {
      ws.close();
    }
  });

  test("handles deny with reason flow (deny → denyreason → reply)", async () => {
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
      approvalMgr.watchSession(2004, session.sessionId);
      await waitForPersistence(500);

      // Register a real pending approval
      const approvalId = server.instance._ctx.approvalGate.requestApproval(
        "echo", { text: "test" }, ["echo"], ["echo"], session.sessionId, worker.workerId,
      );
      const approvalDone = server.instance._ctx.approvalGate.waitForApproval(approvalId).catch(() => {});

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      // Step 1: "Deny" shows two-step keyboard
      await approvalMgr.handleCallback("cb-4", `tool_deny_${approvalId}`);

      // Step 2: "Deny with reason" sends force-reply prompt
      await approvalMgr.handleCallback("cb-5", `tool_denyreason_${approvalId}`);

      const reasonPrompt = sentMessages.find((m) => m.text.includes("denial reason"));
      expect(reasonPrompt).toBeTruthy();

      // Step 3: User replies with reason text
      const consumed = await approvalMgr.tryInterceptReply(2004, reasonPrompt!.messageId, "Too dangerous");
      expect(consumed).toBe(true);

      const deniedEdit = editedMessages.find((m) => m.text.includes("Denied: Too dangerous"));
      expect(deniedEdit).toBeTruthy();

      await approvalDone;
      approvalMgr.cleanup();
    } finally {
      ws.close();
    }
  });

  test("tool_approval_resolved from another client cleans up pending approval", async () => {
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
      approvalMgr.watchSession(2005, session.sessionId);
      await waitForPersistence(500);

      server.instance._ctx.serverBus.emit({ type: "session", sessionId: session.sessionId }, {
        type: "tool_approval_required",
        approvalId: "tc-resolved-test",
        toolName: "echo",
        arguments: '{}',
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      // Simulate another client approving — server emits tool_approval_resolved
      server.instance._ctx.serverBus.emit({ type: "session", sessionId: session.sessionId }, {
        type: "tool_approval_resolved",
        approvalId: "tc-resolved-test",
        outcome: "approved",
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => editedMessages.some((m) => m.text.includes("Approved (elsewhere)")),
        3000,
        "resolved edit message",
      );

      const resolvedEdit = editedMessages.find((m) => m.text.includes("Approved (elsewhere)"));
      expect(resolvedEdit).toBeTruthy();

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
      approvalMgr.watchSession(2006, session.sessionId);
      approvalMgr.watchSession(2006, session.sessionId); // duplicate
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
