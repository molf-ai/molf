import { getLogger } from "@logtape/logtape";
import { streamText, wrapLanguageModel } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { Session, convertToModelMessages, getMessagesFromSummary } from "./session.js";
import { ToolRegistry } from "./tool-registry.js";
import { createConfig, type AgentConfig } from "./config.js";
import { getDefaultSystemPrompt } from "./system-prompts.js";
import { ProviderTransform } from "./providers/transform.js";
import type { ResolvedModel } from "./providers/types.js";
import { pruneContext, isContextLengthError } from "./context-pruner.js";
import type {
  AgentStatus,
  AgentEvent,
  AgentEventHandler,
  SessionMessage,
  ResolvedAttachment,
  ToolCall,
} from "./types.js";

const logger = getLogger(["molf", "agent"]);

/**
 * Normalize tool results to a persistable form.
 * - Strings: return as-is
 * - Arrays (multi-part content from AI SDK): extract text parts, join into a single string
 * - Other: return as-is
 */
function normalizeToolResult(result: unknown): unknown {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const textParts = result
      .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text);
    return textParts.join("\n");
  }
  return result;
}

/** Result collected from a single LLM streaming step. */
interface StepResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>;
  finishReason: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
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
  private currentModel: ResolvedModel;
  private status: AgentStatus = "idle";
  private handlers = new Set<AgentEventHandler>();
  private abortController: AbortController | null = null;
  private lastPromptMessages: SessionMessage[] = [];
  private contextPruningEnabled: boolean;

  constructor(
    config: Partial<{ behavior: Partial<AgentConfig["behavior"]> }> | undefined,
    model: ResolvedModel,
    existingSession?: Session,
  ) {
    this.config = createConfig(config);
    this.currentModel = model;
    this.session = existingSession ?? new Session();
    this.toolRegistry = new ToolRegistry();
    this.contextPruningEnabled = this.config.behavior.contextPruning === true;
  }

  // --- Model management ---

  /** Update the resolved model (for per-prompt model switching). */
  setModel(model: ResolvedModel): void {
    this.currentModel = model;
  }

  getModel(): ResolvedModel {
    return this.currentModel;
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
        logger.error("Agent event handler error", { error: err });
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

  private runtimeContext: string | null = null;

  setRuntimeContext(content: string | null): void {
    this.runtimeContext = content;
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

  async prompt(
    text: string,
    attachments?: ResolvedAttachment[],
    options?: { getSteeringMessage?: () => string | null },
  ): Promise<SessionMessage> {
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

    const model = this.currentModel;
    const contextWindowTokens = model.info.limit.context;
    const wrappedModel = wrapLanguageModel({
      model: model.language as Parameters<typeof wrapLanguageModel>[0]["model"],
      middleware: {
        specificationVersion: "v3" as const,
        transformParams: async ({ params }) => ({
          ...params,
          prompt: ProviderTransform.messages(
            params.prompt as ModelMessage[],
            model.info,
          ) as typeof params.prompt,
        }),
      },
    });

    const systemPrompt =
      this.config.behavior.systemPrompt ?? getDefaultSystemPrompt();
    const tools = this.toolRegistry.getAll();
    const maxSteps = this.config.behavior.maxSteps;

    // Temperature resolution: model capability → per-model default → behavior override → undefined
    const temperature = model.info.capabilities.temperature
      ? (ProviderTransform.temperature(model.info) ?? this.config.behavior.temperature)
      : undefined;
    const maxOutputTokens = ProviderTransform.maxOutputTokens(model.info);

    // Provider-specific options
    const providerOpts = ProviderTransform.options(model.info, "");
    const providerOptions: SharedV3ProviderOptions | undefined =
      Object.keys(providerOpts).length > 0
        ? ProviderTransform.providerOptions(model.info, providerOpts) as SharedV3ProviderOptions
        : undefined;

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
            contextWindowTokens,
            aggressiveMode,
          );
          if (pruned.length !== contextMessages.length) {
            logger.debug("Context pruned", {
              originalMessages: contextMessages.length,
              prunedMessages: pruned.length,
              contextWindowTokens,
              aggressive: aggressiveMode,
            });
          }
          modelMessages = convertToModelMessages(pruned);
        } else {
          modelMessages = convertToModelMessages(contextMessages);
        }

        if (this.runtimeContext) {
          const lastUserIdx = modelMessages.findLastIndex(m => m.role === "user");
          if (lastUserIdx >= 0) {
            modelMessages.splice(lastUserIdx, 0, {
              role: "user" as const,
              content: this.runtimeContext,
            });
          }
        }

        let stepResult: StepResult;
        try {
          stepResult = await this.executeStep(
            wrappedModel, systemPrompt, modelMessages, tools,
            temperature, maxOutputTokens, providerOptions,
          );
        } catch (err) {
          if (isContextLengthError(err) && !aggressiveMode) {
            logger.warn("Context length error, retrying with aggressive pruning");
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
          const lastCall = recentCalls[recentCalls.length - 1];
          logger.warn("Doom loop detected", { doomLoopCount, toolName: lastCall?.toolName });
          if (doomLoopCount >= 2) break;
          // First detection: inject a warning message for the LLM
          this.session.addMessage({
            role: "user",
            content: "You appear to be repeating the same action. Please try a different approach.",
          });
        }

        step++;
        if (stepResult.finishReason !== "tool-calls" || step >= maxSteps) break;

        // Check for steering message between steps
        const steeringText = options?.getSteeringMessage?.();
        if (steeringText) {
          this.session.addMessage({ role: "user", content: steeringText });
          continue;
        }
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
    model: Parameters<typeof streamText>[0]["model"],
    systemPrompt: string,
    modelMessages: ModelMessage[],
    tools: ToolSet,
    temperature: number | undefined,
    maxOutputTokens: number,
    providerOptions: SharedV3ProviderOptions | undefined,
  ): Promise<StepResult> {
    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    const toolResults: StepResult["toolResults"] = [];
    let finishReason = "";

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools,
      abortSignal: this.abortController!.signal,
      temperature,
      maxOutputTokens,
      ...(providerOptions && { providerOptions }),
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

        case "reasoning-delta":
          reasoning += part.text;
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
        stepUsage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.outputTokenDetails?.reasoningTokens != null && {
            reasoningTokens: usage.outputTokenDetails.reasoningTokens,
          }),
          ...(usage.inputTokenDetails?.cacheReadTokens != null && {
            cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
          }),
          ...(usage.inputTokenDetails?.cacheWriteTokens != null && {
            cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
          }),
        };
      }
    } catch {
      // usage not available (e.g. aborted stream)
    }

    logger.debug("LLM step completed", {
      finishReason,
      inputTokens: stepUsage?.inputTokens,
      outputTokens: stepUsage?.outputTokens,
      reasoningTokens: stepUsage?.reasoningTokens,
      cacheReadTokens: stepUsage?.cacheReadTokens,
      cacheWriteTokens: stepUsage?.cacheWriteTokens,
    });

    return { text, reasoning, toolCalls, toolResults, finishReason, usage: stepUsage };
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
        ...(step.reasoning && { reasoning: step.reasoning }),
        toolCalls: step.toolCalls,
        ...(step.usage && { usage: step.usage }),
      });
      this.lastPromptMessages.push(assistantMsg);

      const resultIds = new Set(step.toolResults.map((tr) => tr.toolCallId));

      for (const tr of step.toolResults) {
        const persistContent = normalizeToolResult(tr.result);

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

      // Patch orphaned tool calls: if abort happened mid-execution, some tool calls
      // may not have matching results. Inject synthetic results so the AI SDK doesn't
      // throw MissingToolResultsError on the next prompt.
      for (const tc of step.toolCalls) {
        if (!resultIds.has(tc.toolCallId)) {
          const toolMsg = this.session.addMessage({
            role: "tool",
            content: "Tool execution was cancelled.",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
          });
          this.lastPromptMessages.push(toolMsg);
        }
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
}
