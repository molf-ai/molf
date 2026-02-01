import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { loadConfig, parseServerArgs } from "../src/config.js";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

describe("loadConfig", () => {
  test("no file returns defaults", () => {
    const config = loadConfig(`${tmp.path}/nonexistent.yaml`);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7600);
    expect(config.dataDir).toBe(resolve(process.cwd(), "."));
  });

  test("with YAML file", () => {
    const configPath = tmp.writeFile("config.yaml", "host: 0.0.0.0\nport: 9000\ndataDir: ./mydata");
    const config = loadConfig(configPath);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
  });

  test("partial YAML falls back to defaults", () => {
    const configPath = tmp.writeFile("partial.yaml", "port: 8080");
    const config = loadConfig(configPath);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
  });

  test("resolves relative dataDir from config location", () => {
    const configPath = tmp.writeFile("sub/config.yaml", "dataDir: ./data");
    const config = loadConfig(configPath);
    expect(config.dataDir).toBe(resolve(tmp.path, "sub", "data"));
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
