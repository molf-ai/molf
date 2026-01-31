import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, parseServerArgs } from "../src/config.js";

let testDir: string;

// Mock process.exit for parseServerArgs tests
let exitCode: number | undefined;
let consoleOutput: string[] = [];
const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;

function mockProcessExit() {
  exitCode = undefined;
  consoleOutput = [];
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as never;
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
}

function restoreProcessExit() {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
}

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

describe("parseServerArgs", () => {
  beforeEach(() => mockProcessExit());
  afterEach(() => restoreProcessExit());

  test("extracts --config path", () => {
    const result = parseServerArgs(["--config", "/path/to/config.yaml"]);
    expect(result.config).toContain("config.yaml");
  });

  test("returns undefined config when not provided", () => {
    const result = parseServerArgs([]);
    expect(result.config).toBeUndefined();
  });

  test("extracts -c short alias for config", () => {
    const result = parseServerArgs(["-c", "/path/to/config.yaml"]);
    expect(result.config).toContain("config.yaml");
  });

  test("extracts --host", () => {
    const result = parseServerArgs(["--host", "0.0.0.0"]);
    expect(result.host).toBe("0.0.0.0");
  });

  test("extracts -H short alias for host", () => {
    const result = parseServerArgs(["-H", "0.0.0.0"]);
    expect(result.host).toBe("0.0.0.0");
  });

  test("extracts --port", () => {
    const result = parseServerArgs(["--port", "8080"]);
    expect(result.port).toBe(8080);
  });

  test("extracts -p short alias for port", () => {
    const result = parseServerArgs(["-p", "9000"]);
    expect(result.port).toBe(9000);
  });

  test("--help exits with 0", () => {
    try {
      parseServerArgs(["--help"]);
    } catch {
      // expected
    }
    expect(exitCode).toBe(0);
    expect(consoleOutput.join("\n")).toContain("molf-server");
  });

  test("--version exits with 0", () => {
    try {
      parseServerArgs(["--version"]);
    } catch {
      // expected
    }
    expect(exitCode).toBe(0);
    expect(consoleOutput.join("\n")).toContain("molf-server v0.1.0");
  });

  test("rejects invalid port number", () => {
    try {
      parseServerArgs(["--port", "99999"]);
    } catch {
      // expected
    }
    expect(exitCode).toBe(1);
  });

  test("rejects unknown flags", () => {
    try {
      parseServerArgs(["--unknown-flag"]);
    } catch {
      // expected
    }
    expect(exitCode).toBe(1);
  });
});
