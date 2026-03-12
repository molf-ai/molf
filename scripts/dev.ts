import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

const token = process.env.MOLF_TOKEN ?? "molf-dev-token";
const env = {
  ...process.env,
  MOLF_TOKEN: token,
  MOLF_CREDENTIALS_DIR: "data/clients",
  MOLF_DEFAULT_MODEL: process.env.MOLF_DEFAULT_MODEL ?? "google/gemini-3-flash-preview",
};

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

const server = spawn(
  "tsx",
  ["packages/server/src/main.ts", "--data-dir", "data/server"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
pipe(server.stdout!, "[server]");
pipe(server.stderr!, "[server]");

await new Promise((r) => setTimeout(r, 500));

const worker1 = spawn(
  "tsx",
  [
    "packages/worker/src/index.ts",
    "--workdir",
    "data/worker",
    "--name",
    "default",
    "--tls-ca",
    "data/server/tls/cert.pem",
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
pipe(worker1.stdout!, "[worker:default]");
pipe(worker1.stderr!, "[worker:default]");

const worker2 = spawn(
  "tsx",
  [
    "packages/worker/src/index.ts",
    "--workdir",
    "data/worker-2",
    "--name",
    "secondary",
    "--tls-ca",
    "data/server/tls/cert.pem",
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
pipe(worker2.stdout!, "[worker:secondary]");
pipe(worker2.stderr!, "[worker:secondary]");

const procs: ChildProcess[] = [server, worker1, worker2];

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(
  procs.map((p) => new Promise<void>((resolve) => p.on("close", () => resolve()))),
);
