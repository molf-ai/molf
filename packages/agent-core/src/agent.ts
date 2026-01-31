import { chat, maxIterations } from "@tanstack/ai";
import { createGeminiChat, type GeminiTextModel } from "@tanstack/ai-gemini";
import type { Tool, StreamChunk } from "@tanstack/ai";
import { Session } from "./session.js";
import { ToolRegistry } from "./tool-registry.js";
import { createConfig, type AgentConfig } from "./config.js";
import {
  getDefaultSystemPrompt,
  buildSystemPrompt,
} from "./system-prompts.js";
import type { ToolCall } from "@tanstack/ai";
import type {
  AgentStatus,
  AgentEvent,
  AgentEventHandler,
  SessionMessage,
} from "./types.js";

export class Agent {
  private config: AgentConfig;
  private session: Session;
  private toolRegistry: ToolRegistry;
  private status: AgentStatus = "idle";
  private handlers = new Set<AgentEventHandler>();
  private abortController: AbortController | null = null;
  private lastPromptMessages: SessionMessage[] = [];

  constructor(
    configOverrides?: Partial<{
      llm: Partial<AgentConfig["llm"]>;
      behavior: Partial<AgentConfig["behavior"]>;
    }>,
    existingSession?: Session,
  ) {
    this.config = createConfig(configOverrides);
    this.session = existingSession ?? new Session();
    this.toolRegistry = new ToolRegistry();
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

  registerTool(tool: Tool): void {
    this.toolRegistry.register(tool);
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

  // --- Main prompt flow ---

  async prompt(text: string): Promise<SessionMessage> {
    if (this.status === "streaming" || this.status === "executing_tool") {
      throw new Error("Agent is busy. Abort or wait for current operation.");
    }

    // 1. Add user message to session
    this.session.addMessage({ role: "user", content: text });

    // 2. Set up abort
    this.abortController = new AbortController();

    // 3. Build tools array for chat()
    const tools = this.buildTools();

    // 4. Build system prompts
    const systemPrompt =
      this.config.behavior.systemPrompt ?? getDefaultSystemPrompt();
    const systemPrompts = [systemPrompt];

    // 5. Build agent loop strategy
    const agentLoopStrategy =
      this.config.behavior.agentLoopStrategy ??
      maxIterations(this.config.behavior.maxIterations);

    // 6. Create adapter
    const adapter = this.createAdapter();

    // 7. Get messages in model format
    const messages = this.session.toModelMessages();

    // 8. Call chat() and stream
    this.setStatus("streaming");

    let accumulatedContent = "";
    const pendingToolCalls = new Map<number, ToolCall>();
    this.lastPromptMessages = [];

    try {
      const stream = chat({
        adapter,
        // @tanstack/ai's chat() expects ConstrainedModelMessage[] parameterized
        // by the adapter's modality types. ModelMessage[] is structurally
        // identical for text-only adapters but TypeScript cannot verify this.
        messages: messages as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        tools,
        systemPrompts,
        agentLoopStrategy,
        abortController: this.abortController,
        temperature: this.config.llm.temperature,
        maxTokens: this.config.llm.maxTokens,
      });

      for await (const chunk of stream) {
        if (this.status === "aborted") break;

        this.handleChunk(chunk);

        if (chunk.type === "content") {
          accumulatedContent = chunk.content;
        }

        // Accumulate tool calls (args arrive incrementally, keyed by index)
        if (chunk.type === "tool_call") {
          const idx = chunk.index;
          const existing = pendingToolCalls.get(idx);
          if (!existing) {
            pendingToolCalls.set(idx, {
              id: chunk.toolCall.id,
              type: "function",
              function: {
                name: chunk.toolCall.function.name,
                arguments: chunk.toolCall.function.arguments || "",
              },
            });
          } else {
            existing.function.arguments += chunk.toolCall.function.arguments;
          }
        }

        // Flush assistant+toolCalls message when LLM finishes with tool_calls
        if (
          chunk.type === "done" &&
          chunk.finishReason === "tool_calls" &&
          pendingToolCalls.size > 0
        ) {
          const toolCalls = Array.from(pendingToolCalls.values());
          const msg = this.session.addMessage({
            role: "assistant",
            content: accumulatedContent,
            toolCalls,
          });
          this.lastPromptMessages.push(msg);
          pendingToolCalls.clear();
          accumulatedContent = "";
        }

        // Persist tool result messages
        if (chunk.type === "tool_result") {
          const msg = this.session.addMessage({
            role: "tool",
            content: chunk.content,
            toolCallId: chunk.toolCallId,
          });
          this.lastPromptMessages.push(msg);
        }
      }

      // 9. Add final assistant message to session
      const assistantMessage = this.session.addMessage({
        role: "assistant",
        content: accumulatedContent,
      });
      this.lastPromptMessages.push(assistantMessage);

      this.setStatus("idle");
      this.emit({ type: "turn_complete", message: assistantMessage });

      return assistantMessage;
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

  private createAdapter() {
    const apiKey = this.config.llm.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is required. Set it in the environment or pass it in config.llm.apiKey.",
      );
    }

    return createGeminiChat(this.config.llm.model as GeminiTextModel, apiKey);
  }

  private buildTools(): Tool[] {
    const registeredTools = this.toolRegistry.getAll();
    return registeredTools.map((tool): Tool => {
      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: originalExecute
          ? async (args: unknown) => {
              const toolCallId = `${tool.name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              this.setStatus("executing_tool");
              this.emit({
                type: "tool_call_start",
                toolCallId,
                toolName: tool.name,
                arguments: JSON.stringify(args),
              });

              try {
                const result = await originalExecute(args);
                const resultStr =
                  typeof result === "string" ? result : JSON.stringify(result);

                this.emit({
                  type: "tool_call_end",
                  toolCallId,
                  toolName: tool.name,
                  result: resultStr,
                });

                this.setStatus("streaming");
                return result;
              } catch (err) {
                const error =
                  err instanceof Error ? err : new Error(String(err));
                this.emit({ type: "error", error });
                this.setStatus("streaming");
                throw error;
              }
            }
          : undefined,
      };
    });
  }

  private handleChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case "content":
        this.emit({
          type: "content_delta",
          delta: chunk.delta,
          content: chunk.content,
        });
        break;

      // tool_call and tool_result are handled by the buildTools() execute
      // wrapper which emits tool_call_start/tool_call_end with richer data.

      case "error":
        this.emit({
          type: "error",
          error: new Error(chunk.error.message),
        });
        break;
    }
  }
}
