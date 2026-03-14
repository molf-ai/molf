// --- Size limits ---
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_WS_PAYLOAD_BYTES = 110 * 1024 * 1024; // 110 MB (must exceed max file + framing)

// --- Timeouts ---
export const TOOL_DISPATCH_TIMEOUT_MS = 120_000; // 120s
export const TURN_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
export const IDLE_EVICTION_MS = 30 * 60 * 1000; // 30 min
export const PING_INTERVAL_MS = 30_000; // 30s
export const PONG_TIMEOUT_MS = 10_000; // 10s
