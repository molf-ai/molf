import { builtinToolDefinitions } from "@molf-ai/protocol";
import type { PathArgConfig, WorkerTool } from "../tool-executor.js";
import type { ToolHandler } from "@molf-ai/protocol";
import { shellExecHandler } from "./shell-exec.js";
import { readFileHandler } from "./read-file.js";
import { writeFileHandler } from "./write-file.js";
import { editFileHandler } from "./edit-file.js";
import { globHandler } from "./glob.js";
import { grepHandler } from "./grep.js";

export { shellExecHandler, executeShellCommand } from "./shell-exec.js";
export { readFileHandler } from "./read-file.js";
export { writeFileHandler } from "./write-file.js";
export { editFileHandler } from "./edit-file.js";
export { globHandler } from "./glob.js";
export { grepHandler } from "./grep.js";

// Re-export schemas from protocol for consumers
export {
  shellExecInputSchema,
  readFileInputSchema,
  writeFileInputSchema,
  editFileInputSchema,
  globInputSchema,
  grepInputSchema,
} from "@molf-ai/protocol";

/** Path argument metadata for builtin tools (workdir resolution). */
export const BUILTIN_PATH_ARGS: Record<string, PathArgConfig[]> = {
  shell_exec: [{ name: "cwd", defaultToWorkdir: true }],
  read_file: [{ name: "path" }],
  write_file: [{ name: "path" }],
  edit_file: [{ name: "path" }],
  glob: [{ name: "path", defaultToWorkdir: true }],
  grep: [{ name: "path", defaultToWorkdir: true }],
};

/** Handler registry for builtin tools, keyed by tool name. */
const BUILTIN_HANDLERS: Record<string, ToolHandler> = {
  shell_exec: shellExecHandler,
  read_file: readFileHandler,
  write_file: writeFileHandler,
  edit_file: editFileHandler,
  glob: globHandler,
  grep: grepHandler,
};

/** Get builtin tools as WorkerTool[] for direct registration (with context support). */
export function getBuiltinWorkerTools(): WorkerTool[] {
  return builtinToolDefinitions.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    execute: BUILTIN_HANDLERS[def.name],
    pathArgs: BUILTIN_PATH_ARGS[def.name],
  }));
}
