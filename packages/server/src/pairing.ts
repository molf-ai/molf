import { getLogger } from "@logtape/logtape";
import { timingSafeEqual } from "crypto";

const logger = getLogger(["molf", "server", "pairing"]);

const MAX_CODES = 5;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface PairingEntry {
  codeHash: string;
  name: string;
  expiresAt: number;
}

function hashCode(code: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(code);
  return hasher.digest("hex");
}

function generate6Digit(): string {
  const buf = crypto.getRandomValues(new Uint8Array(4));
  const num = new DataView(buf.buffer).getUint32(0) % 1_000_000;
  return String(num).padStart(6, "0");
}

export class PairingStore {
  private entries = new Map<string, PairingEntry>();

  createCode(name: string): string {
    this.prune();

    if (this.entries.size >= MAX_CODES) {
      throw new Error("Too many active pairing codes (max 5). Wait for existing codes to expire.");
    }

    const code = generate6Digit();
    const id = crypto.randomUUID();

    this.entries.set(id, {
      codeHash: hashCode(code),
      name,
      expiresAt: Date.now() + TTL_MS,
    });

    logger.info("Pairing code created for {name}", { name });
    return code;
  }

  redeemCode(code: string): { name: string } | null {
    this.prune();

    const candidateHash = hashCode(code);

    for (const [id, entry] of this.entries) {
      if (
        candidateHash.length === entry.codeHash.length &&
        timingSafeEqual(Buffer.from(candidateHash), Buffer.from(entry.codeHash))
      ) {
        this.entries.delete(id); // single-use
        logger.info("Pairing code redeemed for {name}", { name: entry.name });
        return { name: entry.name };
      }
    }

    logger.warn("Pairing code redemption failed: invalid code");
    return null;
  }

  prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(id);
      }
    }
  }

  get activeCount(): number {
    this.prune();
    return this.entries.size;
  }
}
