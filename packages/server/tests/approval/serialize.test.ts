import { describe, test, expect } from "bun:test";
import { serializeCompactConfig } from "../../src/approval/serialize.js";

describe("serializeCompactConfig", () => {
  test("empty config produces valid JSONC with comments", () => {
    const result = serializeCompactConfig({});

    expect(result).toContain("// Tool approval permissions");
    expect(result).toContain("{");
    expect(result).toContain("}");
    // Should be parseable as JSON (ignoring comments)
    const jsonPart = result.split("\n").filter((l) => !l.startsWith("//")).join("\n");
    expect(JSON.parse(jsonPart)).toEqual({});
  });

  test("single tool with string action", () => {
    const result = serializeCompactConfig({ "shell_exec": "ask" });

    expect(result).toContain('"shell_exec": "ask"');
    // No trailing comma on last entry
    expect(result).not.toContain('"ask",');
  });

  test("single tool with pattern map", () => {
    const result = serializeCompactConfig({
      "shell_exec": { "git *": "allow", "rm *": "deny" },
    });

    expect(result).toContain('"shell_exec": {');
    expect(result).toContain('"git *": "allow"');
    expect(result).toContain('"rm *": "deny"');
  });

  test("empty pattern map serializes as {}", () => {
    const result = serializeCompactConfig({ "shell_exec": {} });
    expect(result).toContain('"shell_exec": {}');
  });

  test("multiple tools have correct comma placement", () => {
    const result = serializeCompactConfig({
      "shell_exec": "ask",
      "read_file": "allow",
      "write_file": "deny",
    });

    const lines = result.split("\n");
    const shellLine = lines.find((l) => l.includes('"shell_exec"'))!;
    const readLine = lines.find((l) => l.includes('"read_file"'))!;
    const writeLine = lines.find((l) => l.includes('"write_file"'))!;

    // First two should have trailing commas, last should not
    expect(shellLine).toMatch(/,$/);
    expect(readLine).toMatch(/,$/);
    expect(writeLine).not.toMatch(/,$/);
  });

  test("mixed flat and nested entries", () => {
    const result = serializeCompactConfig({
      "read_file": "allow",
      "shell_exec": { "git *": "allow", "rm -rf *": "deny" },
      "*": "ask",
    });

    expect(result).toContain('"read_file": "allow"');
    expect(result).toContain('"shell_exec": {');
    expect(result).toContain('"*": "ask"');
  });

  test("special characters in tool/pattern names are JSON-escaped", () => {
    const result = serializeCompactConfig({
      'tool"name': "allow",
    });

    expect(result).toContain('"tool\\"name"');
  });

  test("header comments mention format and actions", () => {
    const result = serializeCompactConfig({});

    expect(result).toContain('"allow"');
    expect(result).toContain('"deny"');
    expect(result).toContain('"ask"');
    expect(result).toContain("glob");
  });

  test("output ends with trailing newline", () => {
    const result = serializeCompactConfig({});
    expect(result).toMatch(/\n$/);
  });
});
