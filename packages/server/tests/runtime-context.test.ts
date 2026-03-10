import { describe, test, expect } from "vitest";
import { createEnvGuard } from "@molf-ai/test-utils";
import { buildRuntimeContext } from "../src/runtime-context.js";

describe("buildRuntimeContext", () => {
  test("returns string with expected format", () => {
    const result = buildRuntimeContext();
    expect(result).toContain("[Runtime Context]");
    expect(result).toContain("Current time:");
    expect(result).toContain("Timezone:");
  });

  test("respects TZ env var", () => {
    const env = createEnvGuard();
    try {
      env.set("TZ", "America/New_York");
      const result = buildRuntimeContext();
      expect(result).toContain("America/New_York");
    } finally {
      env.restore();
    }
  });
});
