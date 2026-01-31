import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";

// We can't directly test the worker CLI's parseWorkerArgs since it's a local function.
// Instead, test parseCli from @molf-ai/protocol with the worker-like schema.
import { z } from "zod";
import { parseCli, type CliConfig } from "@molf-ai/protocol";

const workerSchema = z.object({
  name: z.string().min(1).optional(),
  workdir: z.string().optional(),
  "server-url": z.string().optional(),
  token: z.string().optional(),
});

const workerCliConfig: CliConfig<typeof workerSchema> = {
  name: "molf-worker",
  version: "0.1.0",
  description: "Molf worker",
  options: {
    name: {
      type: "string",
      short: "n",
      description: "Worker name",
    },
    workdir: {
      type: "string",
      short: "w",
      description: "Working directory",
    },
    "server-url": {
      type: "string",
      short: "s",
      description: "WebSocket server URL",
      default: "ws://127.0.0.1:7600",
      env: "MOLF_SERVER_URL",
    },
    token: {
      type: "string",
      short: "t",
      description: "Auth token",
      env: "MOLF_TOKEN",
    },
  },
  schema: workerSchema,
};

let env: EnvGuard;
beforeEach(() => { env = createEnvGuard(); });
afterEach(() => { env.restore(); });

describe("Worker CLI parsing", () => {
  test("--name flag parsed", () => {
    const result = parseCli(workerCliConfig, ["--name", "my-worker"]);
    expect(result.name).toBe("my-worker");
  });

  test("--workdir flag", () => {
    const result = parseCli(workerCliConfig, ["--workdir", "/tmp/test"]);
    expect(result.workdir).toBe("/tmp/test");
  });

  test("--workdir defaults to undefined when not set", () => {
    const result = parseCli(workerCliConfig, []);
    expect(result.workdir).toBeUndefined();
  });

  test("--server-url flag", () => {
    const result = parseCli(workerCliConfig, ["--server-url", "ws://localhost:9000"]);
    expect(result["server-url"]).toBe("ws://localhost:9000");
  });

  test("--server-url defaults to env var", () => {
    env.set("MOLF_SERVER_URL", "ws://custom:1234");
    const result = parseCli(workerCliConfig, []);
    expect(result["server-url"]).toBe("ws://custom:1234");
  });

  test("--token flag", () => {
    const result = parseCli(workerCliConfig, ["--token", "my-token"]);
    expect(result.token).toBe("my-token");
  });

  test("--token falls back to MOLF_TOKEN env", () => {
    env.set("MOLF_TOKEN", "env-token");
    const result = parseCli(workerCliConfig, []);
    expect(result.token).toBe("env-token");
  });

  test("short flag -n", () => {
    const result = parseCli(workerCliConfig, ["-n", "short-name"]);
    expect(result.name).toBe("short-name");
  });
});
