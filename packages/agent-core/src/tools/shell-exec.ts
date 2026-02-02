import { tool } from "ai";
import { z } from "zod";
import { platform } from "os";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_LENGTH = 50_000;
const BLACKLISTED_SHELLS = ["fish", "nu"];

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

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

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(async () => {
          await killProcessTree(proc);
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
