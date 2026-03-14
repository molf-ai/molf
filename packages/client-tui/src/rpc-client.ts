/**
 * Re-export oRPC client utilities used by the TUI package.
 * This indirection allows tests to mock the client without polluting
 * the global module cache.
 */
export { createORPCClient } from "@orpc/client";
export { RPCLink } from "@orpc/client/websocket";
