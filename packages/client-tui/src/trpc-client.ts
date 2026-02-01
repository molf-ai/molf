/**
 * Re-export tRPC client utilities used by the TUI package.
 * This indirection allows tests to mock the tRPC client without polluting
 * the global module cache (Bun's mock.module is process-wide).
 */
export { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
