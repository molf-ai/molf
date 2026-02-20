import type { ToolSet } from "ai";
import type { PathArgConfig, WorkerTool, ToolExecuteContext } from "../tool-executor.js";
import { shellExecTool, executeShellCommand } from "./shell-exec.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";

export { shellExecTool } from "./shell-exec.js";
export { readFileTool } from "./read-file.js";
export { writeFileTool } from "./write-file.js";
export { editFileTool } from "./edit-file.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";

/** Path argument metadata for builtin tools (workdir resolution). */
export const BUILTIN_PATH_ARGS: Record<string, PathArgConfig[]> = {
  shell_exec: [{ name: "cwd", defaultToWorkdir: true }],
  read_file: [{ name: "path" }],
  write_file: [{ name: "path" }],
  edit_file: [{ name: "path" }],
  glob: [{ name: "path", defaultToWorkdir: true }],
  grep: [{ name: "path", defaultToWorkdir: true }],
};

/**
 * Shell exec WorkerTool that passes context (toolCallId, workdir) through
 * for internal truncation and file storage.
 */
const shellExecWorkerTool: WorkerTool = {
  name: "shell_exec",
  description: shellExecTool.description ?? "",
  inputSchema: shellExecTool.inputSchema,
  pathArgs: BUILTIN_PATH_ARGS.shell_exec,
  execute: async (args: Record<string, unknown>, context?: ToolExecuteContext) => {
    return executeShellCommand(
      args as { command: string; cwd?: string; timeout?: number },
      context ? { toolCallId: context.toolCallId, workdir: context.workdir } : undefined,
    );
  },
};

function getBuiltinTools(): ToolSet {
  return {
    shell_exec: shellExecTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    glob: globTool,
    grep: grepTool,
  };
}

/** Get builtin tools as WorkerTool[] for direct registration (with context support). */
export function getBuiltinWorkerTools(): WorkerTool[] {
  const toolSet = getBuiltinTools();
  const tools: WorkerTool[] = [];

  for (const [name, def] of Object.entries(toolSet)) {
    // Use the context-aware shell_exec wrapper instead of the AI SDK tool
    if (name === "shell_exec") {
      tools.push(shellExecWorkerTool);
      continue;
    }

    tools.push({
      name,
      description: def.description ?? "",
      inputSchema: def.inputSchema,
      execute: def.execute as WorkerTool["execute"],
      pathArgs: BUILTIN_PATH_ARGS[name],
    });
  }

  return tools;
}
