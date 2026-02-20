import { tool } from "ai";
import { z } from "zod";
import { platform } from "os";
import { resolve } from "path";
import { mkdir, writeFile } from "fs/promises";
import { errorMessage, truncateOutput } from "@molf-ai/protocol";
import { isSafeToolCallId } from "../truncation.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const BLACKLISTED_SHELLS = ["fish", "nu"];
const OUTPUT_DIR = ".molf/tool-output";

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

/**
 * Save full output to disk, returning the absolute path.
 * Best-effort: returns undefined if write fails.
 */
async function saveOutputFile(
  workdir: string,
  toolCallId: string,
  suffix: string,
  content: string,
): Promise<string | undefined> {
  try {
    const outputDir = resolve(workdir, OUTPUT_DIR);
    const outputPath = resolve(outputDir, `${toolCallId}_${suffix}.txt`);
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, content, "utf-8");
    return outputPath;
  } catch (err) {
    console.warn(`Failed to save ${suffix} output for ${toolCallId}:`, err);
    return undefined;
  }
}

/** Context passed from ToolExecutor for truncation and file storage. */
export interface ShellExecContext {
  toolCallId?: string;
  workdir?: string;
}

/** Shared execution logic, used by both the AI SDK tool and direct invocation. */
export async function executeShellCommand(
  args: { command: string; cwd?: string; timeout?: number },
  ctx?: ShellExecContext,
): Promise<Record<string, unknown>> {
  const { command, cwd, timeout } = args;
  const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
  const shell = resolveShell();

  try {
    const isWindows = platform() === "win32";
    const proc = Bun.spawn([shell, "-c", command], {
      cwd: cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      ...(isWindows ? {} : { detached: true }),
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

      const stdoutResult = truncateOutput(rawStdout);
      const stderrResult = truncateOutput(rawStderr);

      let stdoutOutputPath: string | undefined;
      let stderrOutputPath: string | undefined;

      // Save full output to disk when truncated (if we have safe context for file paths)
      const safeId = ctx?.toolCallId && isSafeToolCallId(ctx.toolCallId);
      if (stdoutResult.truncated && safeId && ctx?.workdir) {
        stdoutOutputPath = await saveOutputFile(ctx.workdir, ctx.toolCallId!, "stdout", rawStdout);
      }
      if (stderrResult.truncated && safeId && ctx?.workdir) {
        stderrOutputPath = await saveOutputFile(ctx.workdir, ctx.toolCallId!, "stderr", rawStderr);
      }

      const result: Record<string, unknown> = {
        stdout: stdoutResult.content,
        stderr: stderrResult.content,
        exitCode,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
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
  execute: async ({ command, cwd, timeout }) => {
    return executeShellCommand({ command, cwd, timeout });
  },
});
