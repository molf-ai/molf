import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { getLogger } from "@logtape/logtape";
import type { AgentEvent } from "@molf-ai/protocol";
import type { ServerConnection } from "./connection.js";
import type { SessionEventDispatcher } from "./event-dispatcher.js";
import { escapeHtml } from "./format.js";

const logger = getLogger(["molf", "telegram", "approval"]);

const FEEDBACK_TIMEOUT_MS = 5 * 60 * 1000;

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

interface PendingFeedback {
  approvalId: string;
  feedbackMessageId: number;
  timer: ReturnType<typeof setTimeout>;
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
  private pendingFeedback = new Map<number, PendingFeedback>(); // chatId -> PendingFeedback

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

    const match = data.match(/^tool_(approve|always|deny|denynow|denyreason)_(.+)$/);
    if (!match) return;

    const [, action, approvalId] = match;
    const approval = this.pending.get(approvalId);
    if (!approval) return;

    try {
      if (action === "approve" || action === "always") {
        const result = await this.connection.client.tool.approve({
          sessionId: approval.sessionId,
          approvalId: approval.approvalId,
          always: action === "always",
        });
        if (result.applied) {
          await this.editApprovalMessage(approval, action === "always" ? "Always approved" : "Approved");
          this.pending.delete(approvalId);
        }
      } else if (action === "deny") {
        // First step: show two-step keyboard
        const keyboard = new InlineKeyboard()
          .text("Deny", `tool_denynow_${approvalId}`)
          .text("Deny with reason", `tool_denyreason_${approvalId}`);
        try {
          await this.api.editMessageReplyMarkup(approval.chatId, approval.messageId, { reply_markup: keyboard });
        } catch {
          // Ignore edit failures
        }
      } else if (action === "denynow") {
        const result = await this.connection.client.tool.deny({
          sessionId: approval.sessionId,
          approvalId: approval.approvalId,
        });
        if (result.applied) {
          await this.editApprovalMessage(approval, "Denied");
          this.pending.delete(approvalId);
        }
      } else if (action === "denyreason") {
        // Clean up any existing feedback prompt for this chat
        this.cleanupPendingFeedback(approval.chatId);

        // Send ForceReply prompt
        const sent = await this.api.sendMessage(approval.chatId, "Type your denial reason:", {
          reply_markup: { force_reply: true, selective: true },
        });

        // Update original message to show awaiting state
        try {
          await this.api.editMessageReplyMarkup(approval.chatId, approval.messageId, { reply_markup: undefined });
          await this.api.editMessageText(
            approval.chatId,
            approval.messageId,
            `Awaiting denial reason\u2026 <code>${escapeHtml(approval.toolName)}</code>`,
            { parse_mode: "HTML" },
          );
        } catch {
          // Ignore edit failures
        }

        // Store pending feedback with timeout
        const timer = setTimeout(() => {
          this.handleFeedbackTimeout(approval.chatId);
        }, FEEDBACK_TIMEOUT_MS);

        this.pendingFeedback.set(approval.chatId, {
          approvalId,
          feedbackMessageId: sent.message_id,
          timer,
        });
      }
    } catch (err) {
      logger.error("Failed to process approval", { toolName: approval.toolName, approvalId: approval.approvalId, error: err });
    }
  }

  /**
   * Check if an incoming reply is a denial reason for a pending feedback prompt.
   * Returns true if the reply was consumed (caller should not process further).
   */
  async tryInterceptReply(chatId: number, replyToMessageId: number, text: string): Promise<boolean> {
    const feedback = this.pendingFeedback.get(chatId);
    if (!feedback || feedback.feedbackMessageId !== replyToMessageId) return false;

    clearTimeout(feedback.timer);
    this.pendingFeedback.delete(chatId);

    const approval = this.pending.get(feedback.approvalId);
    if (!approval) return true; // Already handled

    try {
      const result = await this.connection.client.tool.deny({
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        feedback: text,
      });
      if (result.applied) {
        await this.editApprovalMessage(approval, `Denied: ${text}`);
        this.pending.delete(feedback.approvalId);
      }
      // If !applied, the approval_resolved event will clean up
    } catch (err) {
      logger.error("Failed to deny with feedback", { approvalId: feedback.approvalId, error: err });
    }

    return true;
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
    for (const feedback of this.pendingFeedback.values()) {
      clearTimeout(feedback.timer);
    }
    this.pendingFeedback.clear();
  }

  private async handleFeedbackTimeout(chatId: number) {
    const feedback = this.pendingFeedback.get(chatId);
    if (!feedback) return;
    this.pendingFeedback.delete(chatId);

    const approval = this.pending.get(feedback.approvalId);
    if (!approval) return;

    try {
      await this.connection.client.tool.deny({
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
      });
      await this.editApprovalMessage(approval, "Denied (timed out)");
    } catch (err) {
      logger.error("Failed to deny on timeout", { approvalId: feedback.approvalId, error: err });
    }

    this.pending.delete(feedback.approvalId);
  }

  private cleanupPendingFeedback(chatId: number) {
    const existing = this.pendingFeedback.get(chatId);
    if (!existing) return;

    clearTimeout(existing.timer);
    this.pendingFeedback.delete(chatId);

    // Auto-deny the previous one without feedback
    const approval = this.pending.get(existing.approvalId);
    if (approval) {
      this.connection.client.tool.deny({
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
      }).catch(() => {});
      this.editApprovalMessage(approval, "Denied").catch(() => {});
      this.pending.delete(existing.approvalId);
    }
  }

  private async handleEvent(chatId: number, event: AgentEvent) {
    // Handle approval resolved (from any client)
    const resolved =
      event.type === "tool_approval_resolved"
        ? event
        : event.type === "subagent_event" && event.event.type === "tool_approval_resolved"
          ? event.event
          : null;
    if (resolved) {
      await this.handleApprovalResolved(resolved.approvalId, resolved.outcome);
      return;
    }

    const approval =
      event.type === "tool_approval_required"
        ? event
        : event.type === "subagent_event" && event.event.type === "tool_approval_required"
          ? event.event
          : null;
    if (!approval) return;

    const { approvalId, toolName, arguments: args, sessionId } = approval;

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

  private async handleApprovalResolved(approvalId: string, outcome: string) {
    const approval = this.pending.get(approvalId);
    if (!approval) return;

    // Clean up any pending feedback for this chat
    const feedback = this.pendingFeedback.get(approval.chatId);
    if (feedback && feedback.approvalId === approvalId) {
      clearTimeout(feedback.timer);
      this.pendingFeedback.delete(approval.chatId);
    }

    const label = outcome === "approved" ? "Approved" : outcome === "denied" ? "Denied" : "Cancelled";
    await this.editApprovalMessage(approval, `${label} (elsewhere)`);
    this.pending.delete(approvalId);
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
