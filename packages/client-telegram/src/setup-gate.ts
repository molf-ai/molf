import type { Api, Context, MiddlewareFn } from "grammy";
import { InlineKeyboard } from "grammy";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ClientOptions } from "ws";
import { getLogger } from "@logtape/logtape";
import { contract } from "@molf-ai/protocol";
import type { RpcClient } from "@molf-ai/protocol";
import {
  probeServerCert,
  saveTlsCert,
  saveServer,
  tlsTrustToWsOpts,
  createUnauthWebSocket,
} from "@molf-ai/protocol";
import type { TlsTrust } from "@molf-ai/protocol";
import { escapeHtml } from "./format.js";

const logger = getLogger(["molf", "telegram", "setup"]);

export type SetupPhase = "need_tls_probe" | "need_tls_approval" | "need_pairing" | "ready";

export interface SetupResult {
  token: string;
  tlsTrust: TlsTrust | null;
}

export interface SetupGateOptions {
  serverUrl: string;
  token: string;
  tlsTrust: TlsTrust | null;
  tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">;
}

export class SetupGate {
  private phase: SetupPhase;
  private fingerprint?: string;
  private certPem?: string;
  private token: string;
  private tlsTrust: TlsTrust | null;
  private serverUrl: string;
  private tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">;
  private resolveReady!: (result: SetupResult) => void;
  private readyPromise: Promise<SetupResult>;
  private promptedChats = new Set<number>();
  private probing = false;

  constructor(opts: SetupGateOptions) {
    this.serverUrl = opts.serverUrl;
    this.token = opts.token;
    this.tlsTrust = opts.tlsTrust;
    this.tlsOpts = opts.tlsOpts;

    const hasToken = opts.token.length > 0;
    const needsTlsApproval = opts.tlsTrust?.mode === "tofu";

    if (needsTlsApproval) {
      this.phase = "need_tls_probe";
    } else if (!hasToken) {
      this.phase = "need_pairing";
    } else {
      this.phase = "ready";
    }

    this.readyPromise = new Promise<SetupResult>((resolve) => {
      this.resolveReady = resolve;
      if (this.phase === "ready") {
        resolve({ token: this.token, tlsTrust: this.tlsTrust });
      }
    });

    logger.info("Setup gate initialized", { phase: this.phase });
  }

  isReady(): boolean {
    return this.phase === "ready";
  }

  getPhase(): SetupPhase {
    return this.phase;
  }

  waitReady(): Promise<SetupResult> {
    return this.readyPromise;
  }

  middleware(): MiddlewareFn {
    return async (ctx, next) => {
      if (this.isReady()) {
        await next();
        return;
      }

      const chatId = ctx.chat?.id;
      if (!chatId || ctx.chat?.type !== "private") return;

      if (ctx.callbackQuery?.data) {
        const data = ctx.callbackQuery.data;

        if (data === "tls_approve") {
          if (this.phase !== "need_tls_approval") {
            await ctx.answerCallbackQuery({ text: "Already handled" });
            return;
          }
          await ctx.answerCallbackQuery();
          const needsPairing = this.approveTls();
          await ctx.editMessageText("TLS fingerprint approved.");
          if (needsPairing) {
            await this.sendPairingPrompt(ctx.api, chatId);
          } else {
            await this.sendWelcome(ctx.api, chatId);
          }
          return;
        }

        if (data === "tls_reject") {
          if (this.phase !== "need_tls_approval") {
            await ctx.answerCallbackQuery({ text: "Already handled" });
            return;
          }
          await ctx.answerCallbackQuery();
          await ctx.editMessageText("TLS fingerprint rejected. Bot shutting down.");
          logger.info("TLS fingerprint rejected by user");
          process.exit(1);
        }

        return;
      }

      if (this.phase === "need_pairing" && ctx.message?.text?.startsWith("/pair")) {
        await this.handlePairCommand(ctx);
        return;
      }

      if (this.phase === "need_tls_probe") {
        await this.probeTls(ctx.api, chatId);
        return;
      }

      if (this.phase === "need_tls_approval" && !this.promptedChats.has(chatId)) {
        this.promptedChats.add(chatId);
        await this.sendTlsApprovalMessage(ctx.api, chatId);
        return;
      }

      if (this.phase === "need_pairing" && !this.promptedChats.has(chatId)) {
        this.promptedChats.add(chatId);
        await this.sendPairingPrompt(ctx.api, chatId);
        return;
      }
    };
  }

  private approveTls(): boolean {
    if (!this.fingerprint || !this.certPem) return false;
    saveTlsCert(this.serverUrl, this.certPem);
    this.tlsTrust = { mode: "pinned", certPem: this.certPem, fingerprint: this.fingerprint };
    this.tlsOpts = tlsTrustToWsOpts(this.tlsTrust);
    logger.info("TLS fingerprint approved and saved", { fingerprint: this.fingerprint });

    if (this.token.length > 0) {
      this.transitionToReady();
      return false;
    } else {
      this.phase = "need_pairing";
      this.promptedChats.clear();
      return true;
    }
  }

  private transitionToReady(): void {
    this.phase = "ready";
    logger.info("Setup complete");
    this.resolveReady({ token: this.token, tlsTrust: this.tlsTrust });
  }

  private async probeTls(api: Api, chatId: number): Promise<void> {
    if (this.probing) return;
    this.probing = true;

    try {
      await api.sendMessage(chatId, "Checking server TLS certificate...");
      const result = await probeServerCert(this.serverUrl);
      this.fingerprint = result.fingerprint;
      this.certPem = result.certPem;
      this.phase = "need_tls_approval";
      this.promptedChats.clear();
      await this.sendTlsApprovalMessage(api, chatId);
      this.promptedChats.add(chatId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("TLS probe failed", { error: msg });
      await api.sendMessage(
        chatId,
        `Could not reach server at <code>${escapeHtml(this.serverUrl)}</code>\n\n` +
        `${escapeHtml(msg)}\n\n` +
        "Check that the server is running, then send any message to retry.",
        { parse_mode: "HTML" },
      );
    } finally {
      this.probing = false;
    }
  }

  private async sendTlsApprovalMessage(api: Api, chatId: number): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("Approve", "tls_approve")
      .text("Reject", "tls_reject");

    const text = [
      "Server TLS fingerprint (first connection):\n",
      `<code>${escapeHtml(this.fingerprint!)}</code>\n`,
      "Verify this matches your server's fingerprint, then approve to continue.",
    ].join("\n");

    await api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  private async sendPairingPrompt(api: Api, chatId: number): Promise<void> {
    await api.sendMessage(
      chatId,
      "Bot is not paired with the server yet.\n\n" +
      "Get a pairing code from the server:\n" +
      "<code>molf-server pair --name telegram</code>\n\n" +
      "Then send: /pair &lt;6-digit code&gt;",
      { parse_mode: "HTML" },
    );
  }

  private async sendWelcome(api: Api, chatId: number): Promise<void> {
    await api.sendMessage(chatId, "Setup complete. Bot is connected and ready to use.");
  }

  private async handlePairCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const text = ctx.message?.text ?? "";
    const code = text.replace(/^\/pair\s*/, "").trim();

    if (!code || !/^\d{6}$/.test(code)) {
      await ctx.reply(
        "Usage: /pair &lt;6-digit code&gt;\n\n" +
        "Get a pairing code from the server:\n" +
        "<code>molf-server pair --name telegram</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    try {
      await ctx.reply("Pairing...");
      const { ws, client } = await this.connectForPairing();

      try {
        const result = await client.auth.redeemPairingCode({ code });
        const certPemToSave = this.certPem;
        saveServer(this.serverUrl, {
          apiKey: result.apiKey,
          name: result.name,
        });
        if (certPemToSave) {
          saveTlsCert(this.serverUrl, certPemToSave);
        }

        this.token = result.apiKey;
        if (certPemToSave && this.tlsTrust?.mode !== "pinned") {
          const fp = this.fingerprint;
          if (fp) {
            this.tlsTrust = { mode: "pinned", certPem: certPemToSave, fingerprint: fp };
            this.tlsOpts = tlsTrustToWsOpts(this.tlsTrust);
          }
        }

        logger.info("Paired via Telegram", { name: result.name });
        await ctx.reply(`Paired as "${result.name}".`);
        this.transitionToReady();
        await this.sendWelcome(ctx.api, chatId);
      } finally {
        ws.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Pairing failed", { error: msg });
      await ctx.reply(`Pairing failed: ${msg}`);
    }
  }

  private connectForPairing(): Promise<{ ws: WebSocket; client: RpcClient }> {
    const TIMEOUT_MS = 5_000;

    return new Promise((resolve, reject) => {
      const url = new URL(this.serverUrl);
      url.searchParams.set("clientId", crypto.randomUUID());
      url.searchParams.set("name", "telegram-pair");
      const urlStr = url.toString();

      const WS = createUnauthWebSocket(this.tlsOpts);
      const ws = new WS(urlStr);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Could not connect to server (timed out after ${TIMEOUT_MS / 1000}s)`));
      }, TIMEOUT_MS);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        const link = new RPCLink({ websocket: ws });
        const client = createORPCClient(link) as RpcClient;
        resolve({ ws, client });
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`Could not connect to server at ${urlStr}`));
      });
    });
  }
}
