import { resolve, isAbsolute } from "path";
import type { WorkerToolInfo } from "@molf-ai/protocol";
import { type ZodType, toJSONSchema } from "zod";

/**
 * A tool definition that can be registered with the worker.
 */
export interface WorkerTool {
  name: string;
  description: string;
  inputSchema?: object;
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Convert a tool's inputSchema (Zod or plain JSON Schema) to a plain JSON Schema object. */
function schemaToJsonSchema(schema: object): Record<string, unknown> {
  if ("_zod" in schema) {
    return toJSONSchema(schema as ZodType) as Record<string, unknown>;
  }
  return schema as Record<string, unknown>;
}

/**
 * Manages tool registration and execution for the worker.
 */
export class ToolExecutor {
  private tools = new Map<string, WorkerTool>();
  private workdir?: string;

  constructor(workdir?: string) {
    this.workdir = workdir;
  }

  registerTool(tool: WorkerTool): void {
    this.tools.set(tool.name, tool);
  }

  registerTools(tools: WorkerTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Register tools from a ToolSet record (e.g. from Vercel AI SDK's tool()).
   * Extracts name from the record key, description/inputSchema/execute from the value.
   */
  registerToolSet(
    toolSet: Record<
      string,
      {
        description?: string;
        inputSchema?: object;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute?: (...args: any[]) => any;
      }
    >,
  ): void {
    for (const [name, def] of Object.entries(toolSet)) {
      this.tools.set(name, {
        name,
        description: def.description ?? "",
        inputSchema: def.inputSchema,
        execute: def.execute as WorkerTool["execute"],
      });
    }
  }

  /**
   * Get tool info for registration with the server.
   */
  getToolInfos(): WorkerToolInfo[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ? schemaToJsonSchema(tool.inputSchema) : {},
    }));
  }

  /**
   * Resolve tool arguments against the configured workdir.
   * - shell_exec: defaults cwd to workdir, resolves relative cwd against workdir
   * - read_file / write_file: resolves relative path against workdir
   * - Other tools: args passed through unchanged
   */
  private resolveWorkdirArgs(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.workdir) return args;

    if (toolName === "shell_exec") {
      const cwd = args.cwd as string | undefined;
      if (!cwd) {
        return { ...args, cwd: this.workdir };
      }
      if (!isAbsolute(cwd)) {
        return { ...args, cwd: resolve(this.workdir, cwd) };
      }
      return args;
    }

    if (toolName === "read_file" || toolName === "write_file") {
      const path = args.path as string | undefined;
      if (path && !isAbsolute(path)) {
        return { ...args, path: resolve(this.workdir, path) };
      }
      return args;
    }

    return args;
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
      const resolvedArgs = this.resolveWorkdirArgs(toolName, args);
      const result = await tool.execute(resolvedArgs);
      return { result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: null, error: message };
    }
  }
}
