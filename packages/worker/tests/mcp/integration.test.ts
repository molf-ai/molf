/**
 * MCP integration tests have been moved to packages/worker/tests/integration/mcp.test.ts
 *
 * They require a separate `bun test` invocation to avoid mock.module() contamination
 * from client.test.ts (Bun's mock.module() is global within a single bun test process).
 *
 * Run via root scripts:
 *   bun run test         # runs all including integration
 *   bun run test:unit    # runs only unit tests (no integration)
 */
