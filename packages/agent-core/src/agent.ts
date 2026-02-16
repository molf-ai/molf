import { streamText } from "ai";
import { Session } from "./session.js";
import { ToolRegistry } from "./tool-registry.js";
import { createConfig, type AgentConfig } from "./config.js";
import { getDefaultSystemPrompt } from "./system-prompts.js";
import { createDefaultRegistry, ProviderRegistry } from "./providers/index.js";
import type { ToolSet } from "ai";
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
  if (
    result !== null &&
    typeof result === "object" &&
    (result as any).type === "binary" &&
    typeof (result as any).data === "string"
  ) {
    const { data, ...rest } = result as Record<string, unknown>;
    return rest;
  }
  return result;
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

  constructor(
    config?: Partial<{
      llm: Partial<AgentConfig["llm"]>;
      behavior: Partial<AgentConfig["behavior"]>;
    }>,
    existingSession?: Session,
  ) {
    this.config = createConfig(config);
    this.session = existingSession ?? new Session();
    this.toolRegistry = new ToolRegistry();
    this.providerRegistry = createDefaultRegistry();
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
      handler(event);
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

    try {
      while (true) {
        if (aborted) break;

        const result = streamText({
          model,
          system: systemPrompt,
          messages: this.session.toModelMessages(),
          tools,
          abortSignal: this.abortController!.signal,
          temperature: this.config.llm.temperature,
          maxOutputTokens: this.config.llm.maxTokens,
        });

        let stepText = "";
        const stepToolCalls: ToolCall[] = [];
        const stepToolResults: {
          toolCallId: string;
          toolName: string;
          result: unknown;
        }[] = [];
        let finishReason = "";

        for await (const part of result.fullStream) {
          if (aborted) break;

          switch (part.type) {
            case "text-delta":
              stepText += part.text;
              this.emit({
                type: "content_delta",
                delta: part.text,
                content: stepText,
              });
              break;

            case "tool-call":
              this.setStatus("executing_tool");
              stepToolCalls.push({
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
              stepToolResults.push({
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

        // Persist step messages to session
        if (stepToolCalls.length > 0) {
          const assistantMsg = this.session.addMessage({
            role: "assistant",
            content: stepText,
            toolCalls: stepToolCalls,
          });
          this.lastPromptMessages.push(assistantMsg);

          for (const tr of stepToolResults) {
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
        } else if (stepText) {
          lastAssistantMessage = this.session.addMessage({
            role: "assistant",
            content: stepText,
          });
          this.lastPromptMessages.push(lastAssistantMessage);
        }

        step++;
        if (finishReason !== "tool-calls" || step >= maxSteps) break;
      }

      if (!lastAssistantMessage) {
        lastAssistantMessage = this.session.addMessage({
          role: "assistant",
          content: "(Reached maximum steps)",
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

  // --- Internal helpers ---

  private createModel() {
    const provider = this.providerRegistry.get(this.config.llm.provider);
    return provider.createModel({
      model: this.config.llm.model,
      apiKey: this.config.llm.apiKey,
    });
  }
}
