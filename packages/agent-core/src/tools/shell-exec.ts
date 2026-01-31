import { tool } from "ai";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 50_000;

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export const shellExecTool = tool({
  description:
    "Execute a shell command and return stdout, stderr, and exit code. " +
    "Commands run via `sh -c`. Use cwd to set working directory. " +
    "Default timeout is 30 seconds.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    cwd: z
      .string()
      .describe("Working directory for the command (default: process cwd)")
      .optional(),
    timeout: z
      .number()
      .describe("Timeout in milliseconds (default: 30000, must be a positive integer)")
      .optional(),
  }),
  execute: async ({ command, cwd, timeout }) => {
    const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;

    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: cwd ?? process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const exitCode = await Promise.race([proc.exited, timeoutPromise]);

      const rawStdout = await new Response(proc.stdout).text();
      const rawStderr = await new Response(proc.stderr).text();

      const stdout = truncate(rawStdout, MAX_OUTPUT_LENGTH);
      const stderr = truncate(rawStderr, MAX_OUTPUT_LENGTH);

      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Command execution failed: ${message}` };
    }
  },
});
