import { tool } from "ai";
import { z } from "zod";
import { platform } from "os";
import { getLogger } from "@logtape/logtape";
import { errorMessage, truncateOutput } from "@molf-ai/protocol";
import { truncateAndStore } from "../truncation.js";

const logger = getLogger(["molf", "worker", "tool"]);

const DEFAULT_TIMEOUT_MS = 120_000;
const BLACKLISTED_SHELLS = ["fish", "nu"];

let cachedShell: string | undefined;

/**
 * Resolve the user's preferred shell for command execution.
 * Respects $SHELL, blacklists incompatible shells (fish, nu),
 * falls back to /bin/zsh on macOS, bash on Linux, /bin/sh as last resort.
 */
export function resolveShell(): string {
  if (cachedShell) return cachedShell;

  const envShell = process.env.SHELL;
  if (envShell) {
    const shellName = envShell.split("/").pop() ?? "";
    if (!BLACKLISTED_SHELLS.includes(shellName)) {
      cachedShell = envShell;
      return cachedShell;
    }
  }

  if (platform() === "darwin") {
    cachedShell = "/bin/zsh";
    return cachedShell;
  }

  const bashPath = Bun.which("bash");
  if (bashPath) {
    cachedShell = bashPath;
    return cachedShell;
  }

  cachedShell = "/bin/sh";
  return cachedShell;
}

/** Reset the cached shell (for testing). */
export function resetShellCache(): void {
  cachedShell = undefined;
}

/**
 * Kill a process tree by sending a signal to the process group.
 * Falls back to proc.kill() if group kill fails.
 */
async function killProcessTree(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const pid = proc.pid;

  try {
    // Send SIGTERM to process group
    process.kill(-pid, "SIGTERM");

    // Wait 200ms for graceful shutdown
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check if still alive, send SIGKILL if so
    try {
      process.kill(-pid, 0); // test if alive
      process.kill(-pid, "SIGKILL");
    } catch {
      // Process already dead, good
    }
  } catch {
    // Group kill failed, fall back to direct kill
    proc.kill();
  }
}

/** Shared execution logic, used by both the AI SDK tool and direct invocation. */
export async function executeShellCommand(
  args: { command: string; cwd?: string; timeout?: number },
  ctx?: { toolCallId?: string; workdir?: string },
): Promise<Record<string, unknown>> {
  const { command, cwd, timeout } = args;
  const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
  const shell = resolveShell();

  try {
    const proc = Bun.spawn([shell, "-c", command], {
      cwd: cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
        killProcessTree(proc);
      }, timeoutMs);
    });

    try {
      const exitCode = await Promise.race([proc.exited, timeoutPromise]);

      const rawStdout = await new Response(proc.stdout).text();
      const rawStderr = await new Response(proc.stderr).text();

      let stdoutContent: string;
      let stderrContent: string;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let stdoutOutputPath: string | undefined;
      let stderrOutputPath: string | undefined;

      if (ctx?.toolCallId && ctx.workdir) {
        const stdoutResult = await truncateAndStore(rawStdout, `${ctx.toolCallId}_stdout`, ctx.workdir);
        const stderrResult = await truncateAndStore(rawStderr, `${ctx.toolCallId}_stderr`, ctx.workdir);
        stdoutContent = stdoutResult.content;
        stderrContent = stderrResult.content;
        stdoutTruncated = stdoutResult.truncated;
        stderrTruncated = stderrResult.truncated;
        stdoutOutputPath = stdoutResult.outputPath;
        stderrOutputPath = stderrResult.outputPath;
      } else {
        const stdoutResult = truncateOutput(rawStdout);
        const stderrResult = truncateOutput(rawStderr);
        stdoutContent = stdoutResult.content;
        stderrContent = stderrResult.content;
        stdoutTruncated = stdoutResult.truncated;
        stderrTruncated = stderrResult.truncated;
      }

      const result: Record<string, unknown> = {
        stdout: stdoutContent,
        stderr: stderrContent,
        exitCode,
        stdoutTruncated,
        stderrTruncated,
      };

      if (stdoutOutputPath) result.stdoutOutputPath = stdoutOutputPath;
      if (stderrOutputPath) result.stderrOutputPath = stderrOutputPath;

      return result;
    } finally {
      clearTimeout(timer!);
    }
  } catch (err) {
    const message = errorMessage(err);
    return { error: `Command execution failed: ${message}` };
  }
}

export const shellExecTool = tool({
  description:
    "Execute a shell command and return stdout, stderr, and exit code. " +
    "Commands run via the user's shell (or sh as fallback). Use cwd to set working directory. " +
    "Default timeout is 120 seconds.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    cwd: z
      .string()
      .describe("Working directory for the command (default: process cwd)")
      .optional(),
    timeout: z
      .number()
      .describe("Timeout in milliseconds (default: 120000, must be a positive integer)")
      .optional(),
  }),
  execute: async (args, extra) => {
    const ctx = extra as { toolCallId?: string; workdir?: string } | undefined;
    return executeShellCommand(args, ctx);
  },
});
