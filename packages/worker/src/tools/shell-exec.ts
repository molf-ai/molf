import { platform } from "os";
import { errorMessage, truncateOutput, shellExecInputSchema } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext, WorkerTool } from "@molf-ai/protocol";
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

/** Drain a ReadableStream into a shared chunks array for interleaved capture. */
async function drainStream(
  stream: ReadableStream<Uint8Array>,
  chunks: Uint8Array[],
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export type ShellCommandResult =
  | { output: string; exitCode: number; truncated: boolean; outputPath?: string }
  | { error: string };

/** Shared execution logic, used by both the tool handler and direct invocation. */
export async function executeShellCommand(
  args: { command: string; cwd?: string; timeout?: number },
  ctx?: { toolCallId?: string; workdir?: string },
): Promise<ShellCommandResult> {
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

      // Drain both streams concurrently into a shared array for chunk-level interleaving
      const chunks: Uint8Array[] = [];
      await Promise.all([
        drainStream(proc.stdout as ReadableStream<Uint8Array>, chunks),
        drainStream(proc.stderr as ReadableStream<Uint8Array>, chunks),
      ]);

      const rawOutput = Buffer.concat(chunks).toString("utf-8");

      let content: string;
      let truncated = false;
      let outputPath: string | undefined;

      if (ctx?.toolCallId && ctx.workdir) {
        const result = await truncateAndStore(rawOutput, ctx.toolCallId, ctx.workdir);
        content = result.content;
        truncated = result.truncated;
        outputPath = result.outputPath;
      } else {
        const result = truncateOutput(rawOutput);
        content = result.content;
        truncated = result.truncated;
      }

      return { output: content, exitCode, truncated, ...(outputPath ? { outputPath } : {}) };
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

  if ("error" in result) {
    return { output: "", error: result.error };
  }

  const output = `${result.output}\n\nexit code: ${result.exitCode}`;

  return {
    output,
    meta: {
      truncated: result.truncated,
      exitCode: result.exitCode,
      ...(result.outputPath ? { outputPath: result.outputPath } : {}),
    },
  };
}

/** Assembled WorkerTool for direct registration / testing. */
export const shellExecTool: WorkerTool = {
  name: "shell_exec",
  description: "Execute a shell command",
  inputSchema: shellExecInputSchema,
  execute: shellExecHandler,
  pathArgs: [{ name: "cwd", defaultToWorkdir: true }],
};
