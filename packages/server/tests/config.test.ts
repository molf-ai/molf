import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { createTmpDir, createEnvGuard, type TmpDir, type EnvGuard } from "@molf-ai/test-utils";
import { loadJsonConfig, resolveServerConfig, parseServerArgs, modifyConfigFile } from "../src/config.js";
import { readFileSync } from "fs";

let tmp: TmpDir;
let env: EnvGuard;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });
beforeEach(() => { env = createEnvGuard(); });
afterEach(() => { env.restore(); });

describe("loadJsonConfig", () => {
  test("missing file returns empty object", () => {
    const result = loadJsonConfig(`${tmp.path}/nonexistent.json`);
    expect(result).toEqual({});
  });

  test("parses host, port, dataDir, and model from JSON", () => {
    const configPath = tmp.writeFile(
      "full.json",
      JSON.stringify({ host: "0.0.0.0", port: 9000, dataDir: "./mydata", model: "anthropic/claude-sonnet-4-20250514" }),
    );
    const result = loadJsonConfig(configPath);
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(9000);
    expect(result.dataDir).toBe(resolve(tmp.path, "mydata"));
    expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("returns partial config when only some fields present", () => {
    const configPath = tmp.writeFile("partial.json", '{ "port": 8080 }');
    const result = loadJsonConfig(configPath);
    expect(result.host).toBeUndefined();
    expect(result.port).toBe(8080);
    expect(result.dataDir).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  test("resolves relative dataDir from config file location", () => {
    const configPath = tmp.writeFile("sub/config.json", '{ "dataDir": "./data" }');
    const result = loadJsonConfig(configPath);
    expect(result.dataDir).toBe(resolve(tmp.path, "sub", "data"));
  });

  test("parses enabled_providers list", () => {
    const configPath = tmp.writeFile(
      "providers.json",
      JSON.stringify({ model: "anthropic/claude-sonnet-4-20250514", enabled_providers: ["google", "openai"] }),
    );
    const result = loadJsonConfig(configPath);
    expect(result.enabled_providers).toEqual(["google", "openai"]);
  });

  test("parses behavior section", () => {
    const configPath = tmp.writeFile(
      "behavior.json",
      JSON.stringify({ model: "anthropic/test", behavior: { temperature: 0.5, contextPruning: true } }),
    );
    const result = loadJsonConfig(configPath);
    expect(result.behavior?.temperature).toBe(0.5);
    expect(result.behavior?.contextPruning).toBe(true);
  });

  test("handles JSONC with comments and trailing commas", () => {
    const configPath = tmp.writeFile(
      "comments.json",
      `{
  // This is a comment
  "model": "anthropic/claude-sonnet-4-20250514",
  "port": 8080, // trailing comma next line
  "host": "0.0.0.0",
}`,
    );
    const result = loadJsonConfig(configPath);
    expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(result.port).toBe(8080);
    expect(result.host).toBe("0.0.0.0");
  });

  test("parses custom_providers", () => {
    const configPath = tmp.writeFile(
      "custom.json",
      JSON.stringify({
        custom_providers: {
          ollama: {
            name: "Ollama",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://localhost:11434/v1" },
            models: {
              llama3: { name: "Llama 3" },
            },
          },
        },
      }),
    );
    const result = loadJsonConfig(configPath);
    expect(result.custom_providers?.ollama).toBeDefined();
    expect(result.custom_providers?.ollama.name).toBe("Ollama");
    expect(result.custom_providers?.ollama.models.llama3.name).toBe("Llama 3");
  });
});

describe("modifyConfigFile", () => {
  test("creates file if it doesn't exist", () => {
    const configPath = resolve(tmp.path, "new-modify.json");
    modifyConfigFile(configPath, ["model"], "anthropic/test");
    const content = readFileSync(configPath, "utf-8");
    expect(JSON.parse(content).model).toBe("anthropic/test");
  });

  test("preserves comments when modifying", () => {
    const configPath = tmp.writeFile(
      "preserve.json",
      `{
  // Default model
  "model": "old-model",
  "port": 7600
}`,
    );
    modifyConfigFile(configPath, ["model"], "new-model");
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("// Default model");
    expect(content).toContain('"new-model"');
    expect(content).toContain('"port": 7600');
  });

  test("sets nested values", () => {
    const configPath = tmp.writeFile(
      "nested.json",
      '{ "behavior": { "temperature": 0.5 } }',
    );
    modifyConfigFile(configPath, ["behavior", "contextPruning"], true);
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.behavior.temperature).toBe(0.5);
    expect(parsed.behavior.contextPruning).toBe(true);
  });
});

describe("resolveServerConfig", () => {
  test("no JSON and no env vars: model is optional", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const config = resolveServerConfig({ config: `${tmp.path}/nonexistent.json` } as ReturnType<typeof parseServerArgs>);
    expect(config.model).toBe("");
  });

  test("model from env with defaults for everything else", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/gemini-2.5-flash");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const config = resolveServerConfig({
      config: `${tmp.path}/nonexistent.json`,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7600);
    expect(config.dataDir).toBe(resolve(process.cwd(), "."));
    expect(config.model).toBe("gemini/gemini-2.5-flash");
    expect(config.token).toBeUndefined();
  });

  test("JSON values used as fallback", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "resolve-json.json",
      JSON.stringify({ host: "0.0.0.0", port: 9000, dataDir: "./mydata", model: "anthropic/claude-sonnet-4-20250514" }),
    );
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("CLI args override JSON", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "cli-override.json",
      JSON.stringify({ host: "0.0.0.0", port: 9000, model: "anthropic/claude-sonnet-4-20250514" }),
    );
    const config = resolveServerConfig({
      config: configPath,
      host: "192.168.1.1",
      port: 3000,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.host).toBe("192.168.1.1");
    expect(config.port).toBe(3000);
  });

  test("model env var overrides JSON model", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/gemini-3-flash-preview");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "model-override.json",
      JSON.stringify({ model: "anthropic/claude-sonnet-4-20250514" }),
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
      config: `${tmp.path}/nonexistent.json`,
      token: "my-secret-token",
    } as ReturnType<typeof parseServerArgs>);
    expect(config.token).toBe("my-secret-token");
  });

  test("providerConfig includes model and enablement settings", () => {
    env.delete("MOLF_DEFAULT_MODEL");
    env.delete("MOLF_HOST");
    env.delete("MOLF_PORT");
    env.delete("MOLF_DATA_DIR");
    env.delete("MOLF_TOKEN");
    const configPath = tmp.writeFile(
      "provider-config.json",
      JSON.stringify({ model: "anthropic/claude-sonnet-4-20250514", enabled_providers: ["google"] }),
    );
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.providerConfig.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(config.providerConfig.enabled_providers).toEqual(["google"]);
  });

  test("configPath is returned", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/test");
    const configPath = tmp.writeFile("with-path.json", "{}");
    const config = resolveServerConfig({
      config: configPath,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.configPath).toBe(configPath);
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
    const result = parseServerArgs(["--config", "/tmp/molf.json"]);
    expect(result.config).toBe(resolve("/tmp/molf.json"));
  });

  test("-c short flag sets config path", () => {
    const result = parseServerArgs(["-c", "/tmp/molf.json"]);
    expect(result.config).toBe(resolve("/tmp/molf.json"));
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
