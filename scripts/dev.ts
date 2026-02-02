const token = process.env.MOLF_TOKEN ?? "molf-dev-token";
const env = { ...process.env, MOLF_TOKEN: token };

function pipe(stream: ReadableStream<Uint8Array>, prefix: string) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        console.log(`${prefix} ${line}`);
      }
    }
    if (buffer) console.log(`${prefix} ${buffer}`);
  })();
}

const server = Bun.spawn(
  ["bun", "run", "packages/server/src/index.ts", "--data-dir", "data/server"],
  { env, stdout: "pipe", stderr: "pipe" },
);
pipe(server.stdout, "[server]");
pipe(server.stderr, "[server]");

await Bun.sleep(500);

const worker1 = Bun.spawn(
  [
    "bun",
    "run",
    "packages/worker/src/index.ts",
    "--workdir",
    "data/worker",
    "--name",
    "default",
  ],
  { env, stdout: "pipe", stderr: "pipe" },
);
pipe(worker1.stdout, "[worker:default]");
pipe(worker1.stderr, "[worker:default]");

const worker2 = Bun.spawn(
  [
    "bun",
    "run",
    "packages/worker/src/index.ts",
    "--workdir",
    "data/worker-2",
    "--name",
    "secondary",
  ],
  { env, stdout: "pipe", stderr: "pipe" },
);
pipe(worker2.stdout, "[worker:secondary]");
pipe(worker2.stderr, "[worker:secondary]");

const procs = [server, worker1, worker2];

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(procs.map((p) => p.exited));
