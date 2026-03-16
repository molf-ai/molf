/**
 * Dev launcher — starts the server, waits for TLS cert, then spawns workers.
 *
 * Usage: pnpm dev
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

// ── Config ──────────────────────────────────────────────────────────

const token = process.env.MOLF_TOKEN ?? "molf-dev-token";
const certPath = "data/server/tls/cert.pem";

const env = {
  ...process.env,
  MOLF_TOKEN: token,
  MOLF_CLIENT_DIR: "data/clients",
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

/** Wait for the server to print its listening banner on stdout. */
function waitForServerReady(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes("Molf server listening on")) {
        stream.off("data", onData);
        stream.off("close", onClose);
        resolve();
      }
    };
    const onClose = () => reject(new Error("Server exited before becoming ready"));
    stream.on("data", onData);
    stream.once("close", onClose);
  });
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

// 2. Wait for the server to be fully listening.
//    The banner is printed after TLS cert generation + listen(), so workers
//    get both the cert file and a connectable server.
await waitForServerReady(server.stdout!);

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
