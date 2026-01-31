import type { ToolSet } from "ai";
import { shellExecTool } from "./shell-exec.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";

export { shellExecTool } from "./shell-exec.js";
export { readFileTool } from "./read-file.js";
export { writeFileTool } from "./write-file.js";

export function getBuiltinTools(): ToolSet {
  return {
    shell_exec: shellExecTool,
    read_file: readFileTool,
    write_file: writeFileTool,
  };
}
