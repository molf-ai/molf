/**
 * Dev launcher — starts the server, waits for TLS cert, then spawns workers.
 *
 * Usage: pnpm dev
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";

// ── Config ──────────────────────────────────────────────────────────

const token = process.env.MOLF_TOKEN ?? "molf-dev-token";
const certPath = "data/server/tls/cert.pem";

const env = {
  ...process.env,
  MOLF_TOKEN: token,
  MOLF_CREDENTIALS_DIR: "data/clients",
  MOLF_DEFAULT_MODEL: process.env.MOLF_DEFAULT_MODEL ?? "google/gemini-3-flash-preview",
};

// ── Helpers ─────────────────────────────────────────────────────────

/** Pipe a child stream to stdout, prefixing each line. */
function pipe(stream: Readable, prefix: string) {
  const decoder = new TextDecoder();
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      console.log(`${prefix} ${line}`);
    }
  });
  stream.on("end", () => {
    if (buffer) console.log(`${prefix} ${buffer}`);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until a file exists on disk (async, so piped output keeps flowing). */
async function waitForFile(path: string) {
  while (!existsSync(path)) await sleep(200);
}

function spawnWorker(name: string, workdir: string) {
  const proc = spawn(
    "tsx",
    [
      "packages/worker/src/index.ts",
      "--workdir", workdir,
      "--name", name,
      "--tls-ca", certPath,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  pipe(proc.stdout!, `[worker:${name}]`);
  pipe(proc.stderr!, `[worker:${name}]`);
  return proc;
}

// ── Start processes ─────────────────────────────────────────────────

// 1. Server
const server = spawn(
  "tsx",
  ["packages/server/src/main.ts", "--data-dir", "data/server"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
pipe(server.stdout!, "[server]");
pipe(server.stderr!, "[server]");

// 2. Wait for the server to generate its self-signed TLS cert.
//    Workers need this file to connect with --tls-ca.
await waitForFile(certPath);

// 3. Workers
const procs: ChildProcess[] = [
  server,
  spawnWorker("default", "data/worker"),
  spawnWorker("secondary", "data/worker-2"),
];

// ── Shutdown ────────────────────────────────────────────────────────

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(
  procs.map((p) => new Promise<void>((resolve) => p.on("close", () => resolve()))),
);
