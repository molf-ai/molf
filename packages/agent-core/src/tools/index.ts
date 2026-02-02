import type { ToolSet } from "ai";
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

export function getBuiltinTools(): ToolSet {
  return {
    shell_exec: shellExecTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    glob: globTool,
    grep: grepTool,
  };
}
