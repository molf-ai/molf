import { resolve, isAbsolute } from "path";
import { errorMessage } from "@molf-ai/protocol";
import type {
  WorkerToolInfo,
  ToolResultEnvelope,
  ToolResultMetadata,
  ToolHandlerContext,
  Attachment,
} from "@molf-ai/protocol";
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

/**
 * A tool definition that can be registered with the worker.
 */
export interface WorkerTool {
  name: string;
  description: string;
  inputSchema?: object;
  execute?: (args: Record<string, unknown>, ctx: ToolHandlerContext) => Promise<ToolResultEnvelope>;
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
   * Returns a ToolResultEnvelope with output, error, meta, and attachments.
   * When the handler does not claim truncation ownership (meta.truncated is undefined),
   * a safety-net truncation pass is applied.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<{
    output: string;
    error?: string;
    meta?: ToolResultMetadata;
    attachments?: Attachment[];
  }> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { output: "", error: `Tool "${toolName}" not found` };
    }

    if (!tool.execute) {
      return { output: "", error: `Tool "${toolName}" has no execute function` };
    }

    try {
      const resolvedArgs = this.resolveWorkdirArgs(tool, args);
      const ctx: ToolHandlerContext = {
        toolCallId: toolCallId ?? "",
        workdir: this.workdir,
      };
      const envelope = await tool.execute(resolvedArgs, ctx);

      // If handler returned an error, pass through
      if (envelope.error) {
        return {
          output: envelope.output,
          error: envelope.error,
          meta: envelope.meta,
          attachments: envelope.attachments,
        };
      }

      const meta = envelope.meta;

      // Truncation safety net:
      // If the handler explicitly set meta.truncated (true or false), it owns truncation — pass through.
      // Otherwise, apply truncateAndStore as a safety net for large outputs.
      if (meta?.truncated !== undefined) {
        return {
          output: envelope.output,
          meta,
          attachments: envelope.attachments,
        };
      }

      if (this.workdir) {
        const truncResult = await truncateAndStore(envelope.output, toolCallId ?? "", this.workdir);
        if (truncResult.truncated) {
          return {
            output: truncResult.content,
            meta: {
              ...meta,
              truncated: true,
              outputId: truncResult.outputId,
            },
            attachments: envelope.attachments,
          };
        }
      }

      return {
        output: envelope.output,
        meta,
        attachments: envelope.attachments,
      };
    } catch (err) {
      return { output: "", error: errorMessage(err) };
    }
  }
}
