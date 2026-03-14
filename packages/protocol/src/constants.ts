// --- Size limits ---
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAX_WS_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// --- Timeouts ---
export const TOOL_DISPATCH_TIMEOUT_MS = 120_000; // 120s
export const TURN_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
export const IDLE_EVICTION_MS = 30 * 60 * 1000; // 30 min
export const PING_INTERVAL_MS = 30_000; // 30s
export const PONG_TIMEOUT_MS = 10_000; // 10s
