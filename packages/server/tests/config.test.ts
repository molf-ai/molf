import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { createTmpDir, createEnvGuard, type TmpDir, type EnvGuard } from "@molf-ai/test-utils";
import { loadConfig, parseServerArgs } from "../src/config.js";

let tmp: TmpDir;
let env: EnvGuard;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });
beforeEach(() => { env = createEnvGuard(); });
afterEach(() => { env.restore(); });

describe("loadConfig", () => {
  test("no file and no env vars throws", () => {
    env.delete("MOLF_LLM_PROVIDER");
    env.delete("MOLF_LLM_MODEL");
    expect(() => loadConfig(`${tmp.path}/nonexistent.yaml`)).toThrow(
      "LLM provider and model are required",
    );
  });

  test("no file with env vars returns defaults + llm from env", () => {
    env.set("MOLF_LLM_PROVIDER", "gemini");
    env.set("MOLF_LLM_MODEL", "gemini-2.5-flash");
    const config = loadConfig(`${tmp.path}/nonexistent.yaml`);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7600);
    expect(config.dataDir).toBe(resolve(process.cwd(), "."));
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-2.5-flash");
  });

  test("with YAML file including llm config", () => {
    env.delete("MOLF_LLM_PROVIDER");
    env.delete("MOLF_LLM_MODEL");
    const configPath = tmp.writeFile(
      "config-llm.yaml",
      "host: 0.0.0.0\nport: 9000\ndataDir: ./mydata\nllm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514",
    );
    const config = loadConfig(configPath);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.llm.provider).toBe("anthropic");
    expect(config.llm.model).toBe("claude-sonnet-4-20250514");
  });

  test("YAML without llm and no env vars throws", () => {
    env.delete("MOLF_LLM_PROVIDER");
    env.delete("MOLF_LLM_MODEL");
    const configPath = tmp.writeFile("no-llm.yaml", "port: 8080");
    expect(() => loadConfig(configPath)).toThrow("LLM provider and model are required");
  });

  test("env vars override YAML llm config", () => {
    env.set("MOLF_LLM_PROVIDER", "gemini");
    env.set("MOLF_LLM_MODEL", "gemini-3-flash-preview");
    const configPath = tmp.writeFile(
      "override-llm.yaml",
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514",
    );
    const config = loadConfig(configPath);
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-3-flash-preview");
  });

  test("partial env var override (provider only)", () => {
    env.set("MOLF_LLM_PROVIDER", "gemini");
    env.delete("MOLF_LLM_MODEL");
    const configPath = tmp.writeFile(
      "partial-override.yaml",
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514",
    );
    const config = loadConfig(configPath);
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("claude-sonnet-4-20250514");
  });

  test("resolves relative dataDir from config location", () => {
    env.set("MOLF_LLM_PROVIDER", "gemini");
    env.set("MOLF_LLM_MODEL", "test");
    const configPath = tmp.writeFile("sub2/config.yaml", "dataDir: ./data");
    const config = loadConfig(configPath);
    expect(config.dataDir).toBe(resolve(tmp.path, "sub2", "data"));
  });
});

describe("parseServerArgs", () => {
  test("no args returns optional fields as undefined", () => {
    const result = parseServerArgs([]);
    expect(result.config).toBeUndefined();
    expect(result["data-dir"]).toBeUndefined();
    expect(result.host).toBeUndefined();
    expect(result.port).toBeUndefined();
  });

  test("--config sets config path", () => {
    const result = parseServerArgs(["--config", "/tmp/molf.yaml"]);
    expect(result.config).toBe(resolve("/tmp/molf.yaml"));
  });

  test("-c short flag sets config path", () => {
    const result = parseServerArgs(["-c", "/tmp/molf.yaml"]);
    expect(result.config).toBe(resolve("/tmp/molf.yaml"));
  });

  test("--port sets port", () => {
    const result = parseServerArgs(["--port", "9000"]);
    expect(result.port).toBe(9000);
  });

  test("-p short flag sets port", () => {
    const result = parseServerArgs(["-p", "8080"]);
    expect(result.port).toBe(8080);
  });

  test("--host sets host", () => {
    const result = parseServerArgs(["--host", "0.0.0.0"]);
    expect(result.host).toBe("0.0.0.0");
  });

  test("-H short flag sets host", () => {
    const result = parseServerArgs(["-H", "0.0.0.0"]);
    expect(result.host).toBe("0.0.0.0");
  });

  test("--data-dir sets and resolves path", () => {
    const result = parseServerArgs(["--data-dir", "./mydata"]);
    expect(result["data-dir"]).toBe(resolve("./mydata"));
  });

  test("-d short flag sets data-dir", () => {
    const result = parseServerArgs(["-d", "/tmp/data"]);
    expect(result["data-dir"]).toBe(resolve("/tmp/data"));
  });

  test("combined flags", () => {
    const result = parseServerArgs(["-H", "0.0.0.0", "-p", "3000"]);
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(3000);
  });
});
