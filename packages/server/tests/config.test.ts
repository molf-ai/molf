import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, parseCliArgs } from "../src/config.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "molf-config-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns defaults when no config file exists", () => {
    const config = loadConfig(join(testDir, "nonexistent.yaml"));

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7600);
    expect(config.dataDir).toContain("data");
  });

  test("loads config from YAML file", () => {
    const configPath = join(testDir, "molf.yaml");
    writeFileSync(
      configPath,
      `host: "0.0.0.0"\nport: 8080\ndataDir: "./custom-data"\n`,
    );

    const config = loadConfig(configPath);

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.dataDir).toContain("custom-data");
  });

  test("resolves relative dataDir from config file location", () => {
    const configPath = join(testDir, "molf.yaml");
    writeFileSync(configPath, `dataDir: "./my-data"\n`);

    const config = loadConfig(configPath);

    expect(config.dataDir).toBe(join(testDir, "my-data"));
  });

  test("uses absolute dataDir as-is", () => {
    const configPath = join(testDir, "molf.yaml");
    writeFileSync(configPath, `dataDir: "/absolute/path/data"\n`);

    const config = loadConfig(configPath);

    expect(config.dataDir).toBe("/absolute/path/data");
  });

  test("uses defaults for missing fields", () => {
    const configPath = join(testDir, "molf.yaml");
    writeFileSync(configPath, `host: "192.168.1.1"\n`);

    const config = loadConfig(configPath);

    expect(config.host).toBe("192.168.1.1");
    expect(config.port).toBe(7600); // default
  });

  test("handles empty YAML file", () => {
    const configPath = join(testDir, "molf.yaml");
    writeFileSync(configPath, "");

    const config = loadConfig(configPath);

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7600);
  });
});

describe("parseCliArgs", () => {
  test("extracts --config path", () => {
    const result = parseCliArgs(["--config", "/path/to/config.yaml"]);
    expect(result.configPath).toContain("config.yaml");
  });

  test("returns undefined when --config not provided", () => {
    const result = parseCliArgs([]);
    expect(result.configPath).toBeUndefined();
  });

  test("returns undefined when --config has no value", () => {
    const result = parseCliArgs(["--config"]);
    expect(result.configPath).toBeUndefined();
  });
});
