import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: ["./packages/test-utils/src/ai-mock-harness.ts"],
    coverage: {
      provider: "v8",
      exclude: [
        "packages/test-utils/**",
        "packages/e2e/helpers/**",
        "**/*.test.ts",
      ],
    },
    include: [
      "packages/*/tests/**/*.test.ts",
      "packages/e2e/tests/**/*.test.ts",
    ],
  },
});
