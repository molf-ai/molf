const token = process.env.MOLF_TOKEN ?? "molf-dev-token";
const env = { ...process.env, MOLF_TOKEN: token };

const server = Bun.spawn(
  ["bun", "run", "packages/server/src/index.ts", "--data-dir", "data/server"],
  { env, stdout: "ignore", stderr: "ignore" },
);

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
  { env, stdout: "ignore", stderr: "ignore" },
);

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
  { env, stdout: "ignore", stderr: "ignore" },
);

await Bun.sleep(500);

const tui = Bun.spawn(["bun", "run", "packages/client-tui/src/index.ts"], {
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await tui.exited;
server.kill();
worker1.kill();
worker2.kill();
process.exit(exitCode);
