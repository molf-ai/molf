const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface RateLimiterConfig {
  perIpLimit: number;
  perIpWindowMs: number;
  globalLimit: number;
  globalWindowMs: number;
  lockoutMs: number;
  pruneIntervalMs?: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  perIpLimit: 5,
  perIpWindowMs: 60_000,
  globalLimit: 20,
  globalWindowMs: 60_000,
  lockoutMs: 5 * 60_000,
  pruneIntervalMs: 60_000,
};

interface IpState {
  timestamps: number[];
  lockedUntil: number;
}

export class RateLimiter {
  private perIp = new Map<string, IpState>();
  private globalTimestamps: number[] = [];
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private readonly config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };

    if (this.config.pruneIntervalMs && this.config.pruneIntervalMs > 0) {
      this.pruneInterval = setInterval(() => this.prune(), this.config.pruneIntervalMs);
      if (typeof this.pruneInterval === "object" && "unref" in this.pruneInterval) {
        this.pruneInterval.unref();
      }
    }
  }

  check(ip: string): { allowed: boolean; reason?: "per_ip" | "global" | "locked" } {
    const now = Date.now();
    const isLoopback = LOOPBACK_IPS.has(ip);

    // Per-IP check (skip for loopback)
    if (!isLoopback) {
      const state = this.perIp.get(ip);
      if (state) {
        // Check lockout
        if (state.lockedUntil > now) {
          return { allowed: false, reason: "locked" };
        }

        // Sliding window
        const windowStart = now - this.config.perIpWindowMs;
        state.timestamps = state.timestamps.filter((t) => t > windowStart);

        if (state.timestamps.length >= this.config.perIpLimit) {
          // Activate lockout
          state.lockedUntil = now + this.config.lockoutMs;
          return { allowed: false, reason: "per_ip" };
        }
      }
    }

    // Global check
    const globalWindowStart = now - this.config.globalWindowMs;
    this.globalTimestamps = this.globalTimestamps.filter((t) => t > globalWindowStart);

    if (this.globalTimestamps.length >= this.config.globalLimit) {
      return { allowed: false, reason: "global" };
    }

    return { allowed: true };
  }

  record(ip: string): void {
    const now = Date.now();
    const isLoopback = LOOPBACK_IPS.has(ip);

    if (!isLoopback) {
      let state = this.perIp.get(ip);
      if (!state) {
        state = { timestamps: [], lockedUntil: 0 };
        this.perIp.set(ip, state);
      }
      state.timestamps.push(now);
    }

    this.globalTimestamps.push(now);
  }

  private prune(): void {
    const now = Date.now();

    // Prune per-IP entries with no recent timestamps and no active lockout
    for (const [ip, state] of this.perIp) {
      const windowStart = now - this.config.perIpWindowMs;
      state.timestamps = state.timestamps.filter((t) => t > windowStart);

      if (state.timestamps.length === 0 && state.lockedUntil <= now) {
        this.perIp.delete(ip);
      }
    }

    // Prune global timestamps
    const globalWindowStart = now - this.config.globalWindowMs;
    this.globalTimestamps = this.globalTimestamps.filter((t) => t > globalWindowStart);
  }

  close(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
  }
}
