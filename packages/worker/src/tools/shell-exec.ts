import { platform } from "os";
import { errorMessage, truncateOutput } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext, ShellResult } from "@molf-ai/protocol";
import { truncateAndStore } from "../truncation.js";

export { shellExecInputSchema } from "@molf-ai/protocol";

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

/** Shared execution logic, used by both the tool handler and direct invocation. */
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

export async function shellExecHandler(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolResultEnvelope> {
  const result = await executeShellCommand(
    args as { command: string; cwd?: string; timeout?: number },
    { toolCallId: ctx.toolCallId, workdir: ctx.workdir },
  );

  if (result.error) {
    return { output: "", error: result.error as string };
  }

  const stdout = result.stdout as string;
  const stderr = result.stderr as string;
  const exitCode = result.exitCode as number;
  const stdoutTruncated = result.stdoutTruncated as boolean;
  const stderrTruncated = result.stderrTruncated as boolean;

  const output = `stdout:\n${stdout}\nstderr:\n${stderr}\nexit code: ${exitCode}`;

  // Shell exec manages its own truncation — claim ownership
  const truncated = stdoutTruncated || stderrTruncated;

  // Include structured shell result in meta for server-side consumption
  // (e.g. agent.shellExec router uses meta.shellResult to return typed data to clients)
  const shellResult: ShellResult = {
    stdout,
    stderr,
    exitCode,
    stdoutTruncated,
    stderrTruncated,
    ...(result.stdoutOutputPath ? { stdoutOutputPath: result.stdoutOutputPath as string } : {}),
    ...(result.stderrOutputPath ? { stderrOutputPath: result.stderrOutputPath as string } : {}),
  };

  return {
    output,
    meta: { truncated, shellResult },
  };
}
