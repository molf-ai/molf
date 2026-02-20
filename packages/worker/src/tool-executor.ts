import { resolve, isAbsolute } from "path";
import { errorMessage, isBinaryResult } from "@molf-ai/protocol";
import type { WorkerToolInfo } from "@molf-ai/protocol";
import { ZodType, toJSONSchema } from "zod";
import { truncateAndStore } from "./truncation.js";

/**
 * Declares how a path argument should be resolved against the workdir.
 */
export interface PathArgConfig {
  /** Argument name (e.g., "path", "cwd"). */
  name: string;
  /** If true, defaults to workdir when the argument is absent. */
  defaultToWorkdir?: boolean;
}

/** Context passed to tool execute functions for truncation and file storage. */
export interface ToolExecuteContext {
  toolCallId?: string;
  workdir?: string;
}

/**
 * A tool definition that can be registered with the worker.
 */
export interface WorkerTool {
  name: string;
  description: string;
  inputSchema?: object;
  execute?: (args: Record<string, unknown>, context?: ToolExecuteContext) => Promise<unknown>;
  /** Declares which arguments are file paths that should be resolved against workdir. */
  pathArgs?: PathArgConfig[];
}

/** Convert a tool's inputSchema (Zod or plain JSON Schema) to a plain JSON Schema object. */
function schemaToJsonSchema(schema: object): Record<string, unknown> {
  if (schema instanceof ZodType) {
    return toJSONSchema(schema) as Record<string, unknown>;
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

  deregisterTools(names: string[]): void {
    for (const name of names) this.tools.delete(name);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Register tools from a ToolSet record (e.g. from Vercel AI SDK's tool()).
   * Extracts name from the record key, description/inputSchema/execute from the value.
   * Optionally accepts pathArgs metadata per tool for workdir resolution.
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
    pathArgs?: Record<string, PathArgConfig[]>,
  ): void {
    for (const [name, def] of Object.entries(toolSet)) {
      this.tools.set(name, {
        name,
        description: def.description ?? "",
        inputSchema: def.inputSchema,
        execute: def.execute as WorkerTool["execute"],
        pathArgs: pathArgs?.[name],
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
   * Resolve tool arguments against the configured workdir using the tool's
   * declared pathArgs metadata. Each path arg is resolved relative to workdir
   * if not absolute; if defaultToWorkdir is set, absent args default to workdir.
   */
  private resolveWorkdirArgs(
    tool: WorkerTool,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.workdir || !tool.pathArgs?.length) return args;

    let resolved = args;
    for (const pathArg of tool.pathArgs) {
      const value = resolved[pathArg.name] as string | undefined;
      if (!value) {
        if (pathArg.defaultToWorkdir) {
          resolved = { ...resolved, [pathArg.name]: this.workdir };
        }
      } else if (!isAbsolute(value)) {
        resolved = { ...resolved, [pathArg.name]: resolve(this.workdir, value) };
      }
    }
    return resolved;
  }

  /**
   * Execute a tool by name with given arguments.
   * When toolCallId is provided and the result is a plain string exceeding
   * truncation thresholds, the full output is saved to disk and a truncated
   * preview is returned.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<{ result: unknown; error?: string; truncated?: boolean; outputId?: string }> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { result: null, error: `Tool "${toolName}" not found` };
    }

    if (!tool.execute) {
      return { result: null, error: `Tool "${toolName}" has no execute function` };
    }

    try {
      const resolvedArgs = this.resolveWorkdirArgs(tool, args);
      const ctx: ToolExecuteContext = { toolCallId, workdir: this.workdir };
      const rawResult = await tool.execute(resolvedArgs, ctx);

      // Truncation layer — only for plain string results
      if (isBinaryResult(rawResult)) {
        return { result: rawResult };
      }
      if (typeof rawResult !== "string") {
        return { result: rawResult };
      }
      if (!toolCallId || !this.workdir) {
        return { result: rawResult };
      }

      const truncResult = await truncateAndStore(rawResult, toolCallId, this.workdir);
      if (truncResult.truncated) {
        return {
          result: truncResult.content,
          truncated: true,
          outputId: truncResult.outputId,
        };
      }
      return { result: rawResult };
    } catch (err) {
      return { result: null, error: errorMessage(err) };
    }
  }
}
