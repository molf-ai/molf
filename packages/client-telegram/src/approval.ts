import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AgentEvent } from "@molf-ai/protocol";
import type { ServerConnection } from "./connection.js";
import { subscribeToEvents } from "./connection.js";

export interface ApprovalManagerOptions {
  api: Api;
  connection: ServerConnection;
}

interface PendingApproval {
  chatId: number;
  messageId: number;
  toolCallId: string;
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
  private pending = new Map<string, PendingApproval>(); // toolCallId -> PendingApproval
  private sessionSubscriptions = new Map<string, () => void>(); // sessionId -> unsubscribe

  constructor(opts: ApprovalManagerOptions) {
    this.api = opts.api;
    this.connection = opts.connection;
  }

  /**
   * Start listening for approval events on a session.
   */
  watchSession(chatId: number, sessionId: string) {
    if (this.sessionSubscriptions.has(sessionId)) return;

    const unsub = subscribeToEvents(
      this.connection.trpc,
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

    const match = data.match(/^tool_(approve|deny)_(.+)$/);
    if (!match) return;

    const [, action, toolCallId] = match;
    const approval = this.pending.get(toolCallId);
    if (!approval) return;

    try {
      if (action === "approve") {
        await this.connection.trpc.tool.approve.mutate({
          sessionId: approval.sessionId,
          toolCallId: approval.toolCallId,
        });
        // Update the message to show approval
        await this.editApprovalMessage(approval, "Approved");
      } else {
        await this.connection.trpc.tool.deny.mutate({
          sessionId: approval.sessionId,
          toolCallId: approval.toolCallId,
        });
        await this.editApprovalMessage(approval, "Denied");
      }
    } catch (err) {
      console.error("[telegram] Failed to process approval:", err);
    }

    this.pending.delete(toolCallId);
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

    const { toolCallId, toolName, arguments: args, sessionId } = event;

    // Truncate arguments for display
    const argsSummary = args.length > 200 ? args.slice(0, 200) + "..." : args;

    const keyboard = new InlineKeyboard()
      .text("Approve", `tool_approve_${toolCallId}`)
      .text("Deny", `tool_deny_${toolCallId}`);

    const text = [
      `Tool call requires approval: <code>${escapeHtml(toolName)}</code>`,
      `Arguments: <code>${escapeHtml(argsSummary)}</code>`,
    ].join("\n");

    try {
      const sent = await this.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });

      this.pending.set(toolCallId, {
        chatId,
        messageId: sent.message_id,
        toolCallId,
        toolName,
        sessionId,
      });
    } catch (err) {
      console.error("[telegram] Failed to send approval request:", err);
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
