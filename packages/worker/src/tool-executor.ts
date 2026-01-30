import type { Tool } from "@molf-ai/agent-core";
import type { WorkerToolInfo } from "@molf-ai/protocol";
import { toJSONSchema } from "zod";

/**
 * Manages tool registration and execution for the worker.
 */
export class ToolExecutor {
  private tools = new Map<string, Tool>();

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerTools(tools: Tool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Get tool info for registration with the server.
   */
  getToolInfos(): WorkerToolInfo[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ? toJSONSchema(tool.inputSchema) as Record<string, unknown> : {},
    }));
  }

  /**
   * Execute a tool by name with given arguments.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result: unknown; error?: string }> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { result: null, error: `Tool "${toolName}" not found` };
    }

    if (!tool.execute) {
      return { result: null, error: `Tool "${toolName}" has no execute function` };
    }

    try {
      const result = await tool.execute(args);
      return { result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: null, error: message };
    }
  }
}
