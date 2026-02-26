import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { getLogger } from "@logtape/logtape";
import type { AgentEvent } from "@molf-ai/protocol";
import type { ServerConnection } from "./connection.js";
import type { SessionEventDispatcher } from "./event-dispatcher.js";
import { escapeHtml } from "./format.js";

const logger = getLogger(["molf", "telegram", "approval"]);

export interface ApprovalManagerOptions {
  api: Api;
  connection: ServerConnection;
  dispatcher: SessionEventDispatcher;
}

interface PendingApproval {
  chatId: number;
  messageId: number;
  approvalId: string;
  toolName: string;
  sessionId: string;
}

/**
 * Manages tool approval inline keyboards.
 *
 * Listens for tool_approval_required events and sends inline keyboard messages.
 * Handles callback queries from Approve/Deny buttons.
 */
export class ApprovalManager {
  private api: Api;
  private connection: ServerConnection;
  private dispatcher: SessionEventDispatcher;
  private pending = new Map<string, PendingApproval>(); // approvalId -> PendingApproval
  private sessionSubscriptions = new Map<string, () => void>(); // sessionId -> unsubscribe

  constructor(opts: ApprovalManagerOptions) {
    this.api = opts.api;
    this.connection = opts.connection;
    this.dispatcher = opts.dispatcher;
  }

  /**
   * Start listening for approval events on a session.
   */
  watchSession(chatId: number, sessionId: string) {
    if (this.sessionSubscriptions.has(sessionId)) return;

    const unsub = this.dispatcher.subscribe(
      sessionId,
      (event) => this.handleEvent(chatId, event),
    );
    this.sessionSubscriptions.set(sessionId, unsub);
  }

  /**
   * Handle a callback query from an inline keyboard button press.
   */
  async handleCallback(callbackQueryId: string, data: string) {
    // Immediately answer the callback to dismiss loading spinner
    try {
      await this.api.answerCallbackQuery(callbackQueryId);
    } catch {
      // Ignore if already answered
    }

    const match = data.match(/^tool_(approve|always|deny)_(.+)$/);
    if (!match) return;

    const [, action, approvalId] = match;
    const approval = this.pending.get(approvalId);
    if (!approval) return;

    try {
      if (action === "approve" || action === "always") {
        await this.connection.trpc.tool.approve.mutate({
          sessionId: approval.sessionId,
          approvalId: approval.approvalId,
          always: action === "always",
        });
        await this.editApprovalMessage(approval, action === "always" ? "Always approved" : "Approved");
      } else {
        await this.connection.trpc.tool.deny.mutate({
          sessionId: approval.sessionId,
          approvalId: approval.approvalId,
        });
        await this.editApprovalMessage(approval, "Denied");
      }
    } catch (err) {
      logger.error("Failed to process approval", { toolName: approval.toolName, approvalId: approval.approvalId, error: err });
    }

    this.pending.delete(approvalId);
  }

  /**
   * Clean up all subscriptions.
   */
  cleanup() {
    for (const unsub of this.sessionSubscriptions.values()) {
      unsub();
    }
    this.sessionSubscriptions.clear();
    this.pending.clear();
  }

  private async handleEvent(chatId: number, event: AgentEvent) {
    if (event.type !== "tool_approval_required") return;

    const { approvalId, toolName, arguments: args, sessionId } = event;

    // Truncate arguments for display
    const argsSummary = args.length > 200 ? args.slice(0, 200) + "..." : args;

    const keyboard = new InlineKeyboard()
      .text("Approve", `tool_approve_${approvalId}`)
      .text("Always", `tool_always_${approvalId}`)
      .text("Deny", `tool_deny_${approvalId}`);

    const text = [
      `Tool call requires approval: <code>${escapeHtml(toolName)}</code>`,
      `Arguments: <code>${escapeHtml(argsSummary)}</code>`,
    ].join("\n");

    try {
      const sent = await this.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });

      this.pending.set(approvalId, {
        chatId,
        messageId: sent.message_id,
        approvalId,
        toolName,
        sessionId,
      });
    } catch (err) {
      logger.error("Failed to send approval request", { toolName, chatId, error: err });
    }
  }

  private async editApprovalMessage(approval: PendingApproval, decision: string) {
    try {
      await this.api.editMessageText(
        approval.chatId,
        approval.messageId,
        `${decision}: <code>${escapeHtml(approval.toolName)}</code>`,
        { parse_mode: "HTML" },
      );
    } catch {
      // Ignore edit failures
    }
  }
}
