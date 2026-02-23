import { stat } from "node:fs/promises";
import { errorMessage } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext } from "@molf-ai/protocol";

export { grepInputSchema } from "@molf-ai/protocol";

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 500;
const GREP_TIMEOUT_MS = 15_000;

let cachedRgPath: string | null | undefined;

function getRipgrepPath(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;
  cachedRgPath = Bun.which("rg");
  return cachedRgPath;
}

/** Reset cached ripgrep path (for testing). */
export function resetRgCache(): void {
  cachedRgPath = undefined;
}

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

function truncateLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  return text.slice(0, MAX_LINE_LENGTH);
}

async function runRipgrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<GrepMatch[]> {
  const args = [
    getRipgrepPath()!,
    "--json",
    "--hidden",
    "--no-messages",
    "--regexp",
    pattern,
  ];
  if (include) {
    args.push("--glob", include);
  }
  args.push(searchPath);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), GREP_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timeout);
  }

  const output = await new Response(proc.stdout).text();
  const matches: GrepMatch[] = [];

  for (const line of output.split("\n")) {
    if (!line) continue;
    if (matches.length >= MAX_MATCHES) break;

    try {
      const msg = JSON.parse(line);
      if (msg.type !== "match") continue;
      const file = msg.data.path.text;
      const lineNum = msg.data.line_number;
      const text = (msg.data.lines.text as string).replace(/\n$/, "");
      matches.push({ file, line: lineNum, text: truncateLine(text) });
    } catch {
      continue;
    }
  }

  return matches;
}

async function runSystemGrep(
  pattern: string,
  searchPath: string,
  include?: string,
): Promise<GrepMatch[]> {
  const args = ["grep", "-rnH"];
  if (include) {
    args.push(`--include=${include}`);
  }
  args.push("--", pattern, searchPath);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), GREP_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timeout);
  }

  const output = await new Response(proc.stdout).text();
  const matches: GrepMatch[] = [];

  for (const line of output.split("\n")) {
    if (!line) continue;
    if (matches.length >= MAX_MATCHES) break;

    // Format: filePath:lineNum:lineText (use indexOf for first two colons)
    const firstColon = line.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;

    const file = line.slice(0, firstColon);
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
    const text = line.slice(secondColon + 1);

    if (!isNaN(lineNum)) {
      matches.push({ file, line: lineNum, text: truncateLine(text) });
    }
  }

  return matches;
}

export async function grepHandler(
  args: Record<string, unknown>,
  _ctx: ToolHandlerContext,
): Promise<ToolResultEnvelope> {
  const { pattern, path, include } = args as {
    pattern: string;
    path?: string;
    include?: string;
  };

  try {
    const searchPath = path ?? process.cwd();

    // Verify path exists
    try {
      await stat(searchPath);
    } catch {
      return { output: "", error: `Path not found: ${searchPath}` };
    }

    const rgPath = getRipgrepPath();
    const matches = rgPath
      ? await runRipgrep(pattern, searchPath, include)
      : await runSystemGrep(pattern, searchPath, include);

    // Stat files for mtime and sort by mtime desc, then line number asc
    const mtimeCache = new Map<string, number>();
    for (const m of matches) {
      if (!mtimeCache.has(m.file)) {
        try {
          const fileStat = await stat(m.file);
          mtimeCache.set(m.file, fileStat.mtimeMs);
        } catch {
          mtimeCache.set(m.file, 0);
        }
      }
    }

    matches.sort((a, b) => {
      const mtimeA = mtimeCache.get(a.file) ?? 0;
      const mtimeB = mtimeCache.get(b.file) ?? 0;
      if (mtimeA !== mtimeB) return mtimeB - mtimeA;
      return a.line - b.line;
    });

    const truncated = matches.length >= MAX_MATCHES;
    const output = matches.length > 0
      ? matches.map(m => `${m.file}:${m.line}: ${m.text}`).join("\n")
      : "No matches found";

    return {
      output,
      meta: { truncated },
    };
  } catch (err) {
    return { output: "", error: `Grep search failed: ${errorMessage(err)}` };
  }
}
