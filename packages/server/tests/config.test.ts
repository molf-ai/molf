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

  test("parses host, port, dataDir, and model from YAML", () => {
    const configPath = tmp.writeFile(
      "full.yaml",
      "host: 0.0.0.0\nport: 9000\ndataDir: ./mydata\nmodel: anthropic/claude-sonnet-4-20250514",
    );
    const result = loadYamlConfig(configPath);
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(9000);
    expect(result.dataDir).toBe(resolve(tmp.path, "mydata"));
    expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("returns partial config when only some fields present", () => {
    const configPath = tmp.writeFile("partial.yaml", "port: 8080");
    const result = loadYamlConfig(configPath);
    expect(result.host).toBeUndefined();
    expect(result.port).toBe(8080);
    expect(result.dataDir).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  test("resolves relative dataDir from config file location", () => {
    const configPath = tmp.writeFile("sub/config.yaml", "dataDir: ./data");
    const result = loadYamlConfig(configPath);
    expect(result.dataDir).toBe(resolve(tmp.path, "sub", "data"));
  });

  test("parses enabled_providers list", () => {
    const configPath = tmp.writeFile(
      "providers.yaml",
      "model: anthropic/claude-sonnet-4-20250514\nenabled_providers:\n  - google\n  - openai",
    );
    const result = loadYamlConfig(configPath);
    expect(result.enabled_providers).toEqual(["google", "openai"]);
  });

  test("parses enable_all_providers flag", () => {
    const configPath = tmp.writeFile(
      "all-providers.yaml",
      "model: anthropic/claude-sonnet-4-20250514\nenable_all_providers: true",
    );
    const result = loadYamlConfig(configPath);
    expect(result.enable_all_providers).toBe(true);
  });

  test("parses behavior section", () => {
    const configPath = tmp.writeFile(
      "behavior.yaml",
      "model: anthropic/test\nbehavior:\n  temperature: 0.5\n  contextPruning: true",
    );
    const result = loadYamlConfig(configPath);
    expect(result.behavior?.temperature).toBe(0.5);
    expect(result.behavior?.contextPruning).toBe(true);
  });
});

describe("resolveServerConfig", () => {
  test("no YAML and no env vars throws for missing model", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    expect(() =>
      resolveServerConfig({ config: `${tmp.path}/nonexistent.yaml` } as ReturnType<typeof parseServerArgs>),
    ).toThrow("Default model is required");
  });

  test("model from env with defaults for everything else", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/gemini-2.5-flash");
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
    expect(config.model).toBe("gemini/gemini-2.5-flash");
    expect(config.token).toBeUndefined();
  });

  test("YAML values used as fallback", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "resolve-yaml.yaml",
      "host: 0.0.0.0\nport: 9000\ndataDir: ./mydata\nmodel: anthropic/claude-sonnet-4-20250514",
    );
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("CLI args override YAML", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "cli-override.yaml",
      "host: 0.0.0.0\nport: 9000\nmodel: anthropic/claude-sonnet-4-20250514",
    );
    const config = resolveServerConfig({
      config: configPath,
      host: "192.168.1.1",
      port: 3000,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.host).toBe("192.168.1.1");
    expect(config.port).toBe(3000);
  });

  test("model env var overrides YAML model", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/gemini-3-flash-preview");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "model-override.yaml",
      "model: anthropic/claude-sonnet-4-20250514",
    );
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.model).toBe("gemini/gemini-3-flash-preview");
  });

  test("token from args is passed through", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/test");
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

  test("YAML without model and no env vars throws", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile("no-model.yaml", "port: 8080");
    expect(() =>
      resolveServerConfig({ config: configPath } as ReturnType<typeof parseServerArgs>),
    ).toThrow("Default model is required");
  });

  test("providerConfig includes model and enablement settings", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "provider-config.yaml",
      "model: anthropic/claude-sonnet-4-20250514\nenabled_providers:\n  - google\nenable_all_providers: false",
    );
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.providerConfig.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(config.providerConfig.enabled_providers).toEqual(["google"]);
    expect(config.providerConfig.enable_all_providers).toBe(false);
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
