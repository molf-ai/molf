import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { resolve } from "path";
import { parseWorkerArgs } from "../src/cli.js";

let env: EnvGuard;
beforeEach(() => { env = createEnvGuard(); });
afterEach(() => { env.restore(); });

describe("parseWorkerArgs", () => {
  test("--name flag parsed", () => {
    const result = parseWorkerArgs(["--name", "my-worker", "--token", "tok"]);
    expect(result.name).toBe("my-worker");
  });

  test("short flag -n", () => {
    const result = parseWorkerArgs(["-n", "short-name", "-t", "tok"]);
    expect(result.name).toBe("short-name");
  });

  test("--workdir flag resolves to absolute path", () => {
    const result = parseWorkerArgs(["--name", "w", "--token", "t", "--workdir", "relative/dir"]);
    expect(result.workdir).toBe(resolve(process.cwd(), "relative/dir"));
  });

  test("--workdir defaults to cwd when not set", () => {
    const result = parseWorkerArgs(["--name", "w", "--token", "t"]);
    expect(result.workdir).toBe(resolve(process.cwd()));
  });

  test("--server-url flag", () => {
    const result = parseWorkerArgs(["--name", "w", "--token", "t", "--server-url", "ws://localhost:9000"]);
    expect(result["server-url"]).toBe("ws://localhost:9000");
  });

  test("--server-url defaults to ws://127.0.0.1:7600", () => {
    const result = parseWorkerArgs(["--name", "w", "--token", "t"]);
    expect(result["server-url"]).toBe("ws://127.0.0.1:7600");
  });

  test("--server-url from MOLF_SERVER_URL env var", () => {
    env.set("MOLF_SERVER_URL", "ws://custom:1234");
    const result = parseWorkerArgs(["--name", "w", "--token", "t"]);
    expect(result["server-url"]).toBe("ws://custom:1234");
  });

  test("--token flag", () => {
    const result = parseWorkerArgs(["--name", "w", "--token", "my-token"]);
    expect(result.token).toBe("my-token");
  });

  test("--token from MOLF_TOKEN env var", () => {
    env.set("MOLF_TOKEN", "env-token");
    const result = parseWorkerArgs(["--name", "w"]);
    expect(result.token).toBe("env-token");
  });

  test("short flag -t for token", () => {
    const result = parseWorkerArgs(["--name", "w", "-t", "short-token"]);
    expect(result.token).toBe("short-token");
  });

  test("absolute workdir is preserved", () => {
    const result = parseWorkerArgs(["--name", "w", "--token", "t", "--workdir", "/absolute/path"]);
    expect(result.workdir).toBe("/absolute/path");
  });
});
