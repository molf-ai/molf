import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { createTmpDir, createEnvGuard, type TmpDir, type EnvGuard } from "@molf-ai/test-utils";
import { loadYamlConfig, resolveServerConfig, parseServerArgs } from "../src/config.js";

let tmp: TmpDir;
let env: EnvGuard;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });
beforeEach(() => { env = createEnvGuard(); });
afterEach(() => { env.restore(); });

describe("loadYamlConfig", () => {
  test("missing file returns empty object", () => {
    const result = loadYamlConfig(`${tmp.path}/nonexistent.yaml`);
    expect(result).toEqual({});
  });

  test("parses host, port, dataDir, and llm from YAML", () => {
    const configPath = tmp.writeFile(
      "full.yaml",
      "host: 0.0.0.0\nport: 9000\ndataDir: ./mydata\nllm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514",
    );
    const result = loadYamlConfig(configPath);
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(9000);
    expect(result.dataDir).toBe(resolve(tmp.path, "mydata"));
    expect(result.llm?.provider).toBe("anthropic");
    expect(result.llm?.model).toBe("claude-sonnet-4-20250514");
  });

  test("returns partial config when only some fields present", () => {
    const configPath = tmp.writeFile("partial.yaml", "port: 8080");
    const result = loadYamlConfig(configPath);
    expect(result.host).toBeUndefined();
    expect(result.port).toBe(8080);
    expect(result.dataDir).toBeUndefined();
    expect(result.llm).toBeUndefined();
  });

  test("resolves relative dataDir from config file location", () => {
    const configPath = tmp.writeFile("sub/config.yaml", "dataDir: ./data");
    const result = loadYamlConfig(configPath);
    expect(result.dataDir).toBe(resolve(tmp.path, "sub", "data"));
  });

  test("YAML with empty llm section omits llm", () => {
    const configPath = tmp.writeFile("empty-llm.yaml", "llm: {}");
    const result = loadYamlConfig(configPath);
    expect(result.llm).toBeUndefined();
  });
});

describe("resolveServerConfig", () => {
  test("no YAML and no env vars throws for missing LLM", () => {
    env.delete("MOLF_LLM_PROVIDER");
    env.delete("MOLF_LLM_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    expect(() =>
      resolveServerConfig({ config: `${tmp.path}/nonexistent.yaml` } as ReturnType<typeof parseServerArgs>),
    ).toThrow("LLM provider and model are required");
  });

  test("LLM from env vars with defaults for everything else", () => {
    env.set("MOLF_LLM_PROVIDER", "gemini");
    env.set("MOLF_LLM_MODEL", "gemini-2.5-flash");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const config = resolveServerConfig({
      config: `${tmp.path}/nonexistent.yaml`,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7600);
    expect(config.dataDir).toBe(resolve(process.cwd(), "."));
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-2.5-flash");
    expect(config.token).toBeUndefined();
  });

  test("YAML values used as fallback", () => {
    env.delete("MOLF_LLM_PROVIDER");
    env.delete("MOLF_LLM_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "resolve-yaml.yaml",
      "host: 0.0.0.0\nport: 9000\ndataDir: ./mydata\nllm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514",
    );
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.llm.provider).toBe("anthropic");
    expect(config.llm.model).toBe("claude-sonnet-4-20250514");
  });

  test("CLI args override YAML", () => {
    env.delete("MOLF_LLM_PROVIDER");
    env.delete("MOLF_LLM_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "cli-override.yaml",
      "host: 0.0.0.0\nport: 9000\nllm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514",
    );
    const config = resolveServerConfig({
      config: configPath,
      host: "192.168.1.1",
      port: 3000,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.host).toBe("192.168.1.1");
    expect(config.port).toBe(3000);
  });

  test("LLM env vars override YAML llm config", () => {
    env.set("MOLF_LLM_PROVIDER", "gemini");
    env.set("MOLF_LLM_MODEL", "gemini-3-flash-preview");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "llm-override.yaml",
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514",
    );
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-3-flash-preview");
  });

  test("partial LLM env var override (provider only)", () => {
    env.set("MOLF_LLM_PROVIDER", "gemini");
    env.delete("MOLF_LLM_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "partial-llm.yaml",
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514",
    );
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("claude-sonnet-4-20250514");
  });

  test("token from args is passed through", () => {
    env.set("MOLF_LLM_PROVIDER", "gemini");
    env.set("MOLF_LLM_MODEL", "test");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const config = resolveServerConfig({
      config: `${tmp.path}/nonexistent.yaml`,
      token: "my-secret-token",
    } as ReturnType<typeof parseServerArgs>);
    expect(config.token).toBe("my-secret-token");
  });

  test("YAML without llm and no env vars throws", () => {
    env.delete("MOLF_LLM_PROVIDER");
    env.delete("MOLF_LLM_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile("no-llm.yaml", "port: 8080");
    expect(() =>
      resolveServerConfig({ config: configPath } as ReturnType<typeof parseServerArgs>),
    ).toThrow("LLM provider and model are required");
  });
});

describe("parseServerArgs", () => {
  test("no args and no env returns optional fields as undefined", () => {
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const result = parseServerArgs([]);
    expect(result.config).toBeUndefined();
    expect(result["data-dir"]).toBeUndefined();
    expect(result.host).toBeUndefined();
    expect(result.port).toBeUndefined();
    expect(result.token).toBeUndefined();
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

  test("--token sets token", () => {
    const result = parseServerArgs(["--token", "my-token"]);
    expect(result.token).toBe("my-token");
  });

  test("-t short flag sets token", () => {
    const result = parseServerArgs(["-t", "my-token"]);
    expect(result.token).toBe("my-token");
  });

  test("combined flags", () => {
    const result = parseServerArgs(["-H", "0.0.0.0", "-p", "3000"]);
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(3000);
  });

  test("MOLF_HOST env var sets host", () => {
    env.set("MOLF_HOST", "0.0.0.0");
    const result = parseServerArgs([]);
    expect(result.host).toBe("0.0.0.0");
  });

  test("MOLF_PORT env var sets port", () => {
    env.set("MOLF_PORT", "9000");
    const result = parseServerArgs([]);
    expect(result.port).toBe(9000);
  });

  test("MOLF_DATA_DIR env var sets data-dir", () => {
    env.set("MOLF_DATA_DIR", "/tmp/molf-data");
    const result = parseServerArgs([]);
    expect(result["data-dir"]).toBe(resolve("/tmp/molf-data"));
  });

  test("MOLF_TOKEN env var sets token", () => {
    env.set("MOLF_TOKEN", "env-token");
    const result = parseServerArgs([]);
    expect(result.token).toBe("env-token");
  });

  test("CLI flag overrides env var", () => {
    env.set("MOLF_HOST", "0.0.0.0");
    const result = parseServerArgs(["--host", "192.168.1.1"]);
    expect(result.host).toBe("192.168.1.1");
  });
});
