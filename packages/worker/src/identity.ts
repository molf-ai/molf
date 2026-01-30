import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

interface WorkerIdentity {
  workerId: string;
}

/**
 * Get or create a persistent worker UUID for the given workdir.
 * Stored in <workdir>/.molf/worker.json
 */
export function getOrCreateWorkerId(workdir: string): string {
  const molfDir = resolve(workdir, ".molf");
  const identityPath = resolve(molfDir, "worker.json");

  if (existsSync(identityPath)) {
    try {
      const data = JSON.parse(readFileSync(identityPath, "utf-8")) as WorkerIdentity;
      if (data.workerId) {
        return data.workerId;
      }
    } catch {
      // Corrupt file, regenerate
    }
  }

  const workerId = crypto.randomUUID();
  mkdirSync(molfDir, { recursive: true });
  writeFileSync(
    identityPath,
    JSON.stringify({ workerId } satisfies WorkerIdentity, null, 2),
  );

  return workerId;
}
