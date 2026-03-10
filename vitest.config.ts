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
    include: [
      "packages/*/tests/**/*.test.{ts,tsx}",
      "packages/e2e/tests/**/*.test.ts",
    ],
  },
});
