import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface TmpDir {
  path: string;
  /** Create a file inside the temp dir. Returns absolute path. */
  writeFile(relativePath: string, content: string): string;
  /** Recursively remove the temp dir. Safe to call multiple times. */
  cleanup(): void;
}

export function createTmpDir(prefix = "molf-test-"): TmpDir {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let cleaned = false;

  return {
    path: dirPath,
    writeFile(relativePath: string, content: string): string {
      const fullPath = path.join(dirPath, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
      return fullPath;
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(dirPath, { recursive: true, force: true });
    },
  };
}
