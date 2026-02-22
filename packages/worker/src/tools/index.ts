import type { ToolSet } from "ai";
import type { PathArgConfig, WorkerTool } from "../tool-executor.js";
import { shellExecTool } from "./shell-exec.js";
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
