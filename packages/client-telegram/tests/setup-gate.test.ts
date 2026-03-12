import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SetupPhase } from "../src/setup-gate.js";

vi.mock("@molf-ai/protocol", () => ({
  probeServerCert: vi.fn(),
  saveTlsCert: vi.fn(),
  saveCredential: vi.fn(),
  tlsTrustToWsOpts: vi.fn(() => ({ rejectUnauthorized: false })),
  createUnauthWebSocket: vi.fn(() => class {}),
}));

vi.mock("@trpc/client", () => ({
  createTRPCClient: vi.fn(),
  createWSClient: vi.fn(),
  wsLink: vi.fn(),
}));

import { SetupGate } from "../src/setup-gate.js";
import { probeServerCert, saveTlsCert, saveCredential } from "@molf-ai/protocol";

const mockProbe = vi.mocked(probeServerCert);
const mockSaveCert = vi.mocked(saveTlsCert);
const mockSaveCredential = vi.mocked(saveCredential);

const FAKE_PEM = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----";

function createMockCtx(overrides: {
  chatId?: number;
  callbackData?: string;
  messageText?: string;
} = {}) {
  const { chatId = 123, callbackData, messageText } = overrides;
  const sendMessage = vi.fn(() => Promise.resolve({ message_id: 1 }));
  const answerCallbackQuery = vi.fn(() => Promise.resolve(true));
  const editMessageText = vi.fn(() => Promise.resolve(true));

  const api = { sendMessage, answerCallbackQuery, editMessageText };

  const ctx: any = {
    chat: { id: chatId, type: "private" },
    api,
    answerCallbackQuery: vi.fn(() => Promise.resolve(true)),
    editMessageText: vi.fn(() => Promise.resolve(true)),
    reply: vi.fn(() => Promise.resolve({ message_id: 2 })),
    callbackQuery: callbackData ? { data: callbackData, id: "cb-1" } : undefined,
    message: messageText ? { text: messageText } : undefined,
  };

  return { ctx, api, sendMessage, answerCallbackQuery };
}

describe("SetupGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initial phase", () => {
    it("starts in need_tls_probe when TOFU mode", () => {
      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "tofu" },
        tlsOpts: { rejectUnauthorized: false },
      });
      expect(gate.getPhase()).toBe("need_tls_probe");
      expect(gate.isReady()).toBe(false);
    });

    it("starts in need_pairing when no token and TLS already trusted", () => {
      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "pinned", certPem: FAKE_PEM, fingerprint: "AA:BB" },
      });
      expect(gate.getPhase()).toBe("need_pairing");
    });

    it("starts in ready when token and TLS resolved", () => {
      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "my-token",
        tlsTrust: { mode: "pinned", certPem: FAKE_PEM, fingerprint: "AA:BB" },
      });
      expect(gate.getPhase()).toBe("ready");
      expect(gate.isReady()).toBe(true);
    });

    it("starts in need_pairing for ws:// with no token", () => {
      const gate = new SetupGate({
        serverUrl: "ws://example.com:7600",
        token: "",
        tlsTrust: null,
      });
      expect(gate.getPhase()).toBe("need_pairing");
    });

    it("starts in ready for ws:// with token", () => {
      const gate = new SetupGate({
        serverUrl: "ws://example.com:7600",
        token: "my-token",
        tlsTrust: null,
      });
      expect(gate.isReady()).toBe(true);
    });
  });

  describe("waitReady", () => {
    it("resolves immediately when already ready", async () => {
      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "my-token",
        tlsTrust: { mode: "pinned", certPem: FAKE_PEM, fingerprint: "AA:BB" },
      });

      const result = await gate.waitReady();
      expect(result.token).toBe("my-token");
      expect(result.tlsTrust).toEqual({ mode: "pinned", certPem: FAKE_PEM, fingerprint: "AA:BB" });
    });
  });

  describe("middleware passthrough when ready", () => {
    it("calls next() when gate is ready", async () => {
      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "my-token",
        tlsTrust: { mode: "pinned", certPem: FAKE_PEM, fingerprint: "AA:BB" },
      });

      const mw = gate.middleware();
      const { ctx } = createMockCtx();
      const next = vi.fn(() => Promise.resolve());

      await mw(ctx, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe("TLS probe phase", () => {
    it("probes server on first interaction and shows approval message", async () => {
      mockProbe.mockResolvedValueOnce({ fingerprint: "AA:BB:CC", certPem: FAKE_PEM });

      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "tofu" },
        tlsOpts: { rejectUnauthorized: false },
      });

      const mw = gate.middleware();
      const { ctx, sendMessage } = createMockCtx({ messageText: "hello" });
      const next = vi.fn();

      await mw(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(mockProbe).toHaveBeenCalledWith("wss://example.com:7600");
      expect(gate.getPhase()).toBe("need_tls_approval");
      // Should have sent "Checking..." + fingerprint approval message
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[1][1]).toContain("AA:BB:CC");
    });

    it("shows error and stays in need_tls_probe when server unreachable", async () => {
      mockProbe.mockRejectedValueOnce(new Error("Connection refused"));

      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "tofu" },
        tlsOpts: { rejectUnauthorized: false },
      });

      const mw = gate.middleware();
      const { ctx, sendMessage } = createMockCtx({ messageText: "hello" });
      const next = vi.fn();

      await mw(ctx, next);

      expect(gate.getPhase()).toBe("need_tls_probe");
      expect(sendMessage.mock.calls[1][1]).toContain("Could not reach server");
      expect(sendMessage.mock.calls[1][1]).toContain("Connection refused");
    });
  });

  describe("TLS approval phase", () => {
    let gate: InstanceType<typeof SetupGate>;

    beforeEach(async () => {
      mockProbe.mockResolvedValueOnce({ fingerprint: "AA:BB:CC", certPem: FAKE_PEM });

      gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "tofu" },
        tlsOpts: { rejectUnauthorized: false },
      });

      // Advance to need_tls_approval
      const mw = gate.middleware();
      const { ctx } = createMockCtx({ messageText: "hello" });
      await mw(ctx, vi.fn());
      expect(gate.getPhase()).toBe("need_tls_approval");
    });

    it("transitions to need_pairing on tls_approve when no token", async () => {
      const mw = gate.middleware();
      const { ctx, sendMessage } = createMockCtx({ callbackData: "tls_approve" });

      await mw(ctx, vi.fn());

      expect(gate.getPhase()).toBe("need_pairing");
      expect(mockSaveCert).toHaveBeenCalledWith("wss://example.com:7600", FAKE_PEM);
      expect(ctx.editMessageText).toHaveBeenCalledWith("TLS fingerprint approved.");
      // Should show pairing prompt
      expect(sendMessage).toHaveBeenCalled();
    });

    it("transitions to ready on tls_approve when token exists", async () => {
      mockProbe.mockResolvedValueOnce({ fingerprint: "DD:EE:FF", certPem: FAKE_PEM });

      const gateWithToken = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "my-token",
        tlsTrust: { mode: "tofu" },
        tlsOpts: { rejectUnauthorized: false },
      });

      // Advance to need_tls_approval
      const mw = gateWithToken.middleware();
      const { ctx: probeCtx } = createMockCtx({ messageText: "hi" });
      await mw(probeCtx, vi.fn());

      // Approve
      const { ctx, sendMessage } = createMockCtx({ callbackData: "tls_approve" });
      await mw(ctx, vi.fn());

      expect(gateWithToken.isReady()).toBe(true);
      // Should show welcome message
      expect(sendMessage).toHaveBeenCalledWith(
        123,
        "Setup complete. Bot is connected and ready to use.",
      );

      const result = await gateWithToken.waitReady();
      expect(result.token).toBe("my-token");
      expect(result.tlsTrust!.mode).toBe("pinned");
      expect(result.tlsTrust!.mode === "pinned" && result.tlsTrust.fingerprint).toBe("DD:EE:FF");
    });

    it("handles tls_reject", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      const mw = gate.middleware();
      const { ctx } = createMockCtx({ callbackData: "tls_reject" });

      await expect(mw(ctx, vi.fn())).rejects.toThrow("process.exit");
      expect(ctx.editMessageText).toHaveBeenCalledWith(
        "TLS fingerprint rejected. Bot shutting down.",
      );

      exitSpy.mockRestore();
    });

    it("handles stale tls_approve after already approved", async () => {
      const mw = gate.middleware();

      // First approve
      const { ctx: ctx1 } = createMockCtx({ callbackData: "tls_approve" });
      await mw(ctx1, vi.fn());
      expect(gate.getPhase()).toBe("need_pairing");

      // Second stale approve
      const { ctx: ctx2 } = createMockCtx({ callbackData: "tls_approve" });
      await mw(ctx2, vi.fn());
      expect(ctx2.answerCallbackQuery).toHaveBeenCalledWith({ text: "Already handled" });
    });
  });

  describe("pairing phase", () => {
    it("shows pairing prompt on non-pair messages", async () => {
      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "pinned", certPem: FAKE_PEM, fingerprint: "AA:BB" },
      });

      expect(gate.getPhase()).toBe("need_pairing");

      const mw = gate.middleware();
      const { ctx, sendMessage } = createMockCtx({ messageText: "hello" });
      const next = vi.fn();

      await mw(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toContain("not paired");
    });

    it("shows pairing prompt only once per chat", async () => {
      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "pinned", certPem: FAKE_PEM, fingerprint: "AA:BB" },
      });

      const mw = gate.middleware();
      const { ctx: ctx1, sendMessage: send1 } = createMockCtx({ messageText: "hi" });
      await mw(ctx1, vi.fn());
      expect(send1).toHaveBeenCalledTimes(1);

      // Second message from same chat — no duplicate prompt
      const { ctx: ctx2, sendMessage: send2 } = createMockCtx({ messageText: "hello" });
      await mw(ctx2, vi.fn());
      expect(send2).not.toHaveBeenCalled();
    });

    it("rejects invalid pairing code", async () => {
      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "pinned", certPem: FAKE_PEM, fingerprint: "AA:BB" },
      });

      const mw = gate.middleware();
      const { ctx } = createMockCtx({ messageText: "/pair abc" });

      await mw(ctx, vi.fn());

      expect(ctx.reply).toHaveBeenCalled();
      expect(ctx.reply.mock.calls[0][0]).toContain("6-digit code");
      expect(gate.getPhase()).toBe("need_pairing");
    });
  });

  describe("full flow: tls_probe → tls_approval → pairing → ready", () => {
    it("completes the full setup flow", async () => {
      mockProbe.mockResolvedValueOnce({ fingerprint: "AA:BB:CC", certPem: FAKE_PEM });

      const gate = new SetupGate({
        serverUrl: "wss://example.com:7600",
        token: "",
        tlsTrust: { mode: "tofu" },
        tlsOpts: { rejectUnauthorized: false },
      });

      const mw = gate.middleware();
      const phases: SetupPhase[] = [gate.getPhase()];

      // Step 1: User sends message → probe → show fingerprint
      const { ctx: ctx1 } = createMockCtx({ messageText: "hello" });
      await mw(ctx1, vi.fn());
      phases.push(gate.getPhase());

      // Step 2: User approves TLS
      const { ctx: ctx2 } = createMockCtx({ callbackData: "tls_approve" });
      await mw(ctx2, vi.fn());
      phases.push(gate.getPhase());

      expect(phases).toEqual(["need_tls_probe", "need_tls_approval", "need_pairing"]);
      expect(mockSaveCert).toHaveBeenCalledWith("wss://example.com:7600", FAKE_PEM);

      // Step 3: Pairing would require connectForPairing which needs a real server,
      // so we test that the gate is in the right state
      expect(gate.isReady()).toBe(false);
    });
  });
});
