import { getLogger } from "@logtape/logtape";
import { generateText } from "ai";
import type { Session } from "@molf-ai/agent-core";
import type { SessionMessage } from "@molf-ai/protocol";
import type { SessionManager } from "./session-mgr.js";
import type { EventBus } from "./event-bus.js";
import type { CachedSession } from "./types.js";

const logger = getLogger(["molf", "server", "summarization"]);

/** Context summarization thresholds */
export const SUMMARIZE_THRESHOLD_RATIO = 0.8;
export const MIN_MESSAGES_FOR_SUMMARY = 6;
export const KEEP_RECENT_TURNS = 4;
export const SUMMARIZE_MAX_TOKENS = 4096;
export const SUMMARIZE_TEMPERATURE = 0.3;
export const MIN_SUMMARY_LENGTH = 100;
export const SUMMARIZE_MAX_CHARS_PER_MSG = 2000;

export const SUMMARIZE_SYSTEM_PROMPT = `Summarize the conversation so far to enable seamless continuation.

Follow this template:

## Goal
[What is the user trying to accomplish?]

## Key Instructions
[Important constraints, preferences, or standing instructions from the user]

## Progress
[What has been accomplished, what is in progress, what remains]

## Key Findings
[Important discoveries, decisions, or technical details learned during the conversation]

## Relevant Files
[Files read, edited, or created — organized by relevance to current work]

Be thorough but concise. Another agent will use this summary to continue the work without access to the original messages.`;

/** Find the index of the last summary anchor (user boundary of the summary pair). */
export function findSummaryAnchor(messages: readonly SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].summary && messages[i].role === "assistant") {
      return i > 0 && messages[i - 1].summary ? i - 1 : i;
    }
  }
  return 0;
}

export function shouldSummarize(messages: readonly SessionMessage[], contextWindowTokens: number): boolean {
  if (contextWindowTokens === 0) return false;
  if (messages.length === 0) return false;
  if (messages.length < MIN_MESSAGES_FOR_SUMMARY) return false;

  const anchorIdx = findSummaryAnchor(messages);
  const activeMessages = messages.slice(anchorIdx);

  if (activeMessages.length < MIN_MESSAGES_FOR_SUMMARY) return false;

  // Use actual token count from the most recent LLM call
  for (let i = activeMessages.length - 1; i >= 0; i--) {
    if (activeMessages[i].role === "assistant" && activeMessages[i].usage) {
      return activeMessages[i].usage!.inputTokens / contextWindowTokens >= SUMMARIZE_THRESHOLD_RATIO;
    }
  }

  return false;
}

export async function performSummarization(
  activeSession: CachedSession,
  deps: {
    sessionMgr: SessionManager;
    eventBus: EventBus;
    /** Returns the in-memory Session if the agent is still cached, undefined otherwise. */
    getAgentSession: () => Session | undefined;
  },
): Promise<void> {
  activeSession.summarizing = true;
  try {
    const messages = deps.sessionMgr.getMessages(activeSession.sessionId);
    const anchorIdx = findSummaryAnchor(messages);

    // Find cutoff: preserve last KEEP_RECENT_TURNS user turns
    let userTurnCount = 0;
    let cutoffIdx = messages.length;
    for (let i = messages.length - 1; i >= anchorIdx; i--) {
      if (messages[i].role === "user" && !messages[i].synthetic) {
        userTurnCount++;
        if (userTurnCount >= KEEP_RECENT_TURNS) {
          cutoffIdx = i;
          break;
        }
      }
    }

    // Nothing to summarize if cutoff is at or before anchor
    if (cutoffIdx <= anchorIdx) return;

    const messagesToSummarize = messages.slice(anchorIdx, cutoffIdx);
    if (messagesToSummarize.length === 0) return;

    // Build conversation transcript for summarization, truncating long messages
    const transcript = messagesToSummarize
      .map((m) => {
        const content = m.content.length > SUMMARIZE_MAX_CHARS_PER_MSG
          ? m.content.slice(0, SUMMARIZE_MAX_CHARS_PER_MSG) + "\n[...truncated]"
          : m.content;
        return `[${m.role}]: ${content}`;
      })
      .join("\n\n");

    // Reuse the model from the last turn for summarization
    const resolvedModel = activeSession.lastResolvedModel;
    if (!resolvedModel) return;

    const result = await generateText({
      model: resolvedModel.language,
      system: SUMMARIZE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcript }],
      maxOutputTokens: SUMMARIZE_MAX_TOKENS,
      temperature: SUMMARIZE_TEMPERATURE,
    });

    const summaryText = result.text.trim();
    if (summaryText.length < MIN_SUMMARY_LENGTH) {
      return;
    }

    // Create summary messages
    const now = Date.now();

    const userBoundary: SessionMessage = {
      id: `msg_${now}_${crypto.randomUUID().slice(0, 8)}`,
      role: "user",
      content: "[Conversation context was summarized to manage the context window]",
      timestamp: now,
      synthetic: true,
      summary: true,
    };

    const assistantSummary: SessionMessage = {
      id: `msg_${now + 1}_${crypto.randomUUID().slice(0, 8)}`,
      role: "assistant",
      content: summaryText,
      timestamp: now + 1,
      synthetic: true,
      summary: true,
    };

    // Dual-write to SessionManager (disk)
    deps.sessionMgr.addMessage(activeSession.sessionId, userBoundary);
    deps.sessionMgr.addMessage(activeSession.sessionId, assistantSummary);
    await deps.sessionMgr.save(activeSession.sessionId);

    // Dual-write to in-memory Session (if cached)
    const session = deps.getAgentSession();
    if (session) {
      session.addMessage({
        id: userBoundary.id,
        timestamp: userBoundary.timestamp,
        role: userBoundary.role,
        content: userBoundary.content,
        synthetic: true,
        summary: true,
      });
      session.addMessage({
        id: assistantSummary.id,
        timestamp: assistantSummary.timestamp,
        role: assistantSummary.role,
        content: assistantSummary.content,
        synthetic: true,
        summary: true,
      });
    }

    // Clear loadedInstructions so nested docs are re-injected after summarization
    activeSession.loadedInstructions.clear();

    // Emit event
    deps.eventBus.emit(activeSession.sessionId, {
      type: "context_compacted",
      summaryMessageId: assistantSummary.id,
    });

    logger.info("Summarization completed", { sessionId: activeSession.sessionId });
  } catch (err) {
    logger.warn("Summarization failed", { sessionId: activeSession.sessionId, error: err });
  } finally {
    activeSession.summarizing = false;
  }
}
