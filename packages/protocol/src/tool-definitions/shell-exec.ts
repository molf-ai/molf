import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const shellExecInputSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z
    .string()
    .describe("Working directory for the command (default: process cwd)")
    .optional(),
  timeout: z
    .number()
    .describe("Timeout in milliseconds (default: 120000, must be a positive integer)")
    .optional(),
});

export const shellExecDefinition: ToolDefinition = {
  name: "shell_exec",
  description:
    "Execute a shell command and return stdout, stderr, and exit code. " +
    "Commands run via the user's shell (or sh as fallback). Use cwd to set working directory. " +
    "Default timeout is 120 seconds.",
  inputSchema: shellExecInputSchema,
};
