import { streamText } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { isBinaryResult } from "@molf-ai/protocol";
import { Session, convertToModelMessages, getMessagesFromSummary } from "./session.js";
import { ToolRegistry } from "./tool-registry.js";
import { createConfig, type AgentConfig } from "./config.js";
import { getDefaultSystemPrompt } from "./system-prompts.js";
import { createDefaultRegistry, ProviderRegistry } from "./providers/index.js";
import { pruneContext, isContextLengthError } from "./context-pruner.js";
import type { LanguageModel } from "./providers/index.js";
import type {
  AgentStatus,
  AgentEvent,
  AgentEventHandler,
  SessionMessage,
  ResolvedAttachment,
  ToolCall,
} from "./types.js";

/** Strip base64 data from binary tool results before session persistence. */
function stripBinaryData(result: unknown): unknown {
  if (isBinaryResult(result)) {
    const { data, ...rest } = result;
    return rest;
  }
  return result;
}

/** Result collected from a single LLM streaming step. */
interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>;
  finishReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Detect doom loops: returns true if the last 3 tool calls are identical
 * (same tool name and same serialized arguments).
 */
function detectDoomLoop(recentCalls: Array<{ toolName: string; args: string }>): boolean {
  if (recentCalls.length < 3) return false;
  const last3 = recentCalls.slice(-3);
  return last3.every(
    (c) => c.toolName === last3[0].toolName && c.args === last3[0].args,
  );
}

export class Agent {
  private config: AgentConfig;
  private session: Session;
  private toolRegistry: ToolRegistry;
  private providerRegistry: ProviderRegistry;
  private status: AgentStatus = "idle";
  private handlers = new Set<AgentEventHandler>();
  private abortController: AbortController | null = null;
  private lastPromptMessages: SessionMessage[] = [];
  private contextPruningEnabled: boolean;
  private contextWindowTokens: number;

  constructor(
    config?: Partial<{
      llm: Partial<AgentConfig["llm"]>;
      behavior: Partial<AgentConfig["behavior"]>;
    }>,
    existingSession?: Session,
    providerRegistry?: ProviderRegistry,
  ) {
    this.config = createConfig(config);
    this.session = existingSession ?? new Session();
    this.toolRegistry = new ToolRegistry();
    this.providerRegistry = providerRegistry ?? createDefaultRegistry();

    this.contextPruningEnabled = this.config.behavior.contextPruning === true;
    const provider = this.providerRegistry.get(this.config.llm.provider);
    this.contextWindowTokens =
      this.config.llm.contextWindow
      ?? provider.getContextWindow?.(this.config.llm.model)
      ?? 200_000;
  }

  // --- Event subscription ---

  onEvent(handler: AgentEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("Event handler error:", err);
      }
    }
  }

  private setStatus(status: AgentStatus): void {
    this.status = status;
    this.emit({ type: "status_change", status });
  }

  // --- Tool management ---

  registerTool(name: string, toolDef: ToolSet[string]): void {
    this.toolRegistry.register(name, toolDef);
  }

  registerTools(tools: ToolSet): void {
    for (const [name, toolDef] of Object.entries(tools)) {
      this.toolRegistry.register(name, toolDef);
    }
  }

  unregisterTool(name: string): boolean {
    return this.toolRegistry.unregister(name);
  }

  replaceTools(tools: ToolSet): void {
    this.toolRegistry.clear();
    for (const [name, toolDef] of Object.entries(tools)) {
      this.toolRegistry.register(name, toolDef);
    }
  }

  setSystemPrompt(prompt: string): void {
    this.config.behavior.systemPrompt = prompt;
  }

  // --- Session management ---

  getSession(): Session {
    return this.session;
  }

  resetSession(): void {
    this.session.clear();
    this.setStatus("idle");
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getLastPromptMessages(): readonly SessionMessage[] {
    return this.lastPromptMessages;
  }

  // --- Abort ---

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.setStatus("aborted");
    }
  }

  // --- Main prompt flow (manual agent loop) ---

  async prompt(text: string, attachments?: ResolvedAttachment[]): Promise<SessionMessage> {
    if (this.status === "streaming" || this.status === "executing_tool") {
      throw new Error("Agent is busy. Abort or wait for current operation.");
    }

    this.session.addMessage({
      role: "user",
      content: text,
      ...(attachments?.length ? { attachments } : {}),
    });
    this.abortController = new AbortController();
    this.setStatus("streaming");
    this.lastPromptMessages = [];

    const model = this.createModel();
    const systemPrompt =
      this.config.behavior.systemPrompt ?? getDefaultSystemPrompt();
    const tools = this.toolRegistry.getAll();
    const maxSteps = this.config.behavior.maxSteps;

    let step = 0;
    let lastAssistantMessage: SessionMessage | undefined;
    let aborted = false;
    let aggressiveMode = false;
    const recentCalls: Array<{ toolName: string; args: string }> = [];
    let doomLoopCount = 0;

    try {
      while (true) {
        if (aborted) break;

        // Get context window (from last summary forward, or all if no summary)
        const contextMessages = getMessagesFromSummary(this.session.getMessages());

        let modelMessages: ModelMessage[];
        if (this.contextPruningEnabled || aggressiveMode) {
          const pruned = pruneContext(
            contextMessages,
            this.contextWindowTokens,
            aggressiveMode,
          );
          modelMessages = convertToModelMessages(pruned);
        } else {
          modelMessages = convertToModelMessages(contextMessages);
        }

        let stepResult: StepResult;
        try {
          stepResult = await this.executeStep(model, systemPrompt, modelMessages, tools);
        } catch (err) {
          if (isContextLengthError(err) && !aggressiveMode) {
            aggressiveMode = true;
            continue;
          }
          throw err;
        }

        const { assistantMsg, doomLoopDetected } = this.persistStepMessages(stepResult, recentCalls);
        if (assistantMsg) {
          // Prefer messages with text content; only use empty-text messages as a last resort
          if (assistantMsg.content || !lastAssistantMessage) {
            lastAssistantMessage = assistantMsg;
          }
        }
        if (doomLoopDetected) {
          doomLoopCount++;
          if (doomLoopCount >= 2) break;
          // First detection: inject a warning message for the LLM
          this.session.addMessage({
            role: "user",
            content: "You appear to be repeating the same action. Please try a different approach.",
          });
        }

        step++;
        if (stepResult.finishReason !== "tool-calls" || step >= maxSteps) break;
      }

      if (!lastAssistantMessage) {
        const reachedMaxSteps = step >= maxSteps;
        lastAssistantMessage = this.session.addMessage({
          role: "assistant",
          content: reachedMaxSteps ? "(Reached maximum steps)" : "(No text response)",
        });
        this.lastPromptMessages.push(lastAssistantMessage);
      }

      this.setStatus("idle");
      this.emit({ type: "turn_complete", message: lastAssistantMessage });

      return lastAssistantMessage;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (error.name === "AbortError" || this.status === "aborted") {
        this.setStatus("aborted");
      } else {
        this.setStatus("error");
        this.emit({ type: "error", error });
      }

      throw error;
    } finally {
      this.abortController = null;
    }
  }

  // --- Step execution ---

  /** Execute a single LLM streaming step: call the model, process the stream, collect results. */
  private async executeStep(
    model: LanguageModel,
    systemPrompt: string,
    modelMessages: ModelMessage[],
    tools: ToolSet,
  ): Promise<StepResult> {
    let text = "";
    const toolCalls: ToolCall[] = [];
    const toolResults: StepResult["toolResults"] = [];
    let finishReason = "";

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools,
      abortSignal: this.abortController!.signal,
      temperature: this.config.llm.temperature,
      maxOutputTokens: this.config.llm.maxTokens,
    });

    for await (const part of result.fullStream) {
      if (this.abortController?.signal.aborted) break;

      switch (part.type) {
        case "text-delta":
          text += part.text;
          this.emit({
            type: "content_delta",
            delta: part.text,
            content: text,
          });
          break;

        case "tool-call":
          this.setStatus("executing_tool");
          toolCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: (part.input ?? {}) as Record<string, unknown>,
            providerMetadata: part.providerMetadata as
              | Record<string, Record<string, unknown>>
              | undefined,
          });
          this.emit({
            type: "tool_call_start",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            arguments: JSON.stringify(part.input),
          });
          break;

        case "tool-result":
          toolResults.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.output,
          });
          this.emit({
            type: "tool_call_end",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result:
              typeof part.output === "string"
                ? part.output
                : JSON.stringify(part.output),
          });
          this.setStatus("streaming");
          break;

        case "tool-error":
          this.emit({
            type: "error",
            error: new Error(String(part.error)),
          });
          this.setStatus("streaming");
          break;

        case "finish":
          finishReason = part.finishReason;
          break;

        case "error":
          this.emit({
            type: "error",
            error:
              part.error instanceof Error
                ? part.error
                : new Error(String(part.error)),
          });
          break;
      }
    }

    let stepUsage: StepResult["usage"];
    try {
      const usage = await result.usage;
      if (usage?.inputTokens != null && usage?.outputTokens != null) {
        stepUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
      }
    } catch {
      // usage not available (e.g. aborted stream)
    }

    return { text, toolCalls, toolResults, finishReason, usage: stepUsage };
  }

  // --- Step persistence ---

  /**
   * Persist a step's messages to the session and track doom loops.
   * Returns the assistant message if it contained text content, and whether a doom loop was detected.
   */
  private persistStepMessages(
    step: StepResult,
    recentCalls: Array<{ toolName: string; args: string }>,
  ): { assistantMsg: SessionMessage | undefined; doomLoopDetected: boolean } {
    if (step.toolCalls.length > 0) {
      const assistantMsg = this.session.addMessage({
        role: "assistant",
        content: step.text,
        toolCalls: step.toolCalls,
        ...(step.usage && { usage: step.usage }),
      });
      this.lastPromptMessages.push(assistantMsg);

      for (const tr of step.toolResults) {
        const persistContent = stripBinaryData(tr.result);

        const toolMsg = this.session.addMessage({
          role: "tool",
          content:
            typeof persistContent === "string"
              ? persistContent
              : JSON.stringify(persistContent),
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
        });
        this.lastPromptMessages.push(toolMsg);
      }

      // Accumulate for doom loop detection
      for (const tc of step.toolCalls) {
        recentCalls.push({ toolName: tc.toolName, args: JSON.stringify(tc.args) });
      }
      const doomLoopDetected = detectDoomLoop(recentCalls);

      return { assistantMsg, doomLoopDetected };
    }

    if (step.text) {
      const assistantMsg = this.session.addMessage({
        role: "assistant",
        content: step.text,
        ...(step.usage && { usage: step.usage }),
      });
      this.lastPromptMessages.push(assistantMsg);
      return { assistantMsg, doomLoopDetected: false };
    }

    return { assistantMsg: undefined, doomLoopDetected: false };
  }

  // --- Internal helpers ---

  private createModel() {
    const provider = this.providerRegistry.get(this.config.llm.provider);
    return provider.createModel({
      model: this.config.llm.model,
      apiKey: this.config.llm.apiKey,
    });
  }
}
