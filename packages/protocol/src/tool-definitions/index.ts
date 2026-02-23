import type { ToolDefinition } from "../types.js";

export { readFileDefinition, readFileInputSchema } from "./read-file.js";
export { writeFileDefinition, writeFileInputSchema } from "./write-file.js";
export { editFileDefinition, editFileInputSchema } from "./edit-file.js";
export { shellExecDefinition, shellExecInputSchema } from "./shell-exec.js";
export { globDefinition, globInputSchema } from "./glob.js";
export { grepDefinition, grepInputSchema } from "./grep.js";

import { readFileDefinition } from "./read-file.js";
import { writeFileDefinition } from "./write-file.js";
import { editFileDefinition } from "./edit-file.js";
import { shellExecDefinition } from "./shell-exec.js";
import { globDefinition } from "./glob.js";
import { grepDefinition } from "./grep.js";

export const builtinToolDefinitions: ToolDefinition[] = [
  shellExecDefinition,
  readFileDefinition,
  writeFileDefinition,
  editFileDefinition,
  globDefinition,
  grepDefinition,
];
