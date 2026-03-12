import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    pool: "vmThreads",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: [],
    coverage: {
      provider: "v8",
      exclude: [
        "packages/test-utils/**",
        "packages/e2e/helpers/**",
        "**/*.test.ts",
      ],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/tests/**/*.test.{ts,tsx}"],
          exclude: ["packages/e2e/**", "packages/plugin-mcp/tests/integration/**"],
        },
      },
      {
        test: {
          name: "e2e",
          include: [
            "packages/e2e/tests/integration/**/*.test.ts",
            "packages/plugin-mcp/tests/integration/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "live",
          include: ["packages/e2e/tests/live/**/*.test.ts"],
        },
      },
    ],
  },
});
