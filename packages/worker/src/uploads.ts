import { resolve, join, basename } from "path";
import { mkdir, writeFile } from "node:fs/promises";

const UPLOADS_DIR = ".molf/uploads";

export async function saveUploadedFile(
  workdir: string,
  buffer: Uint8Array,
  filename: string,
): Promise<{ path: string; size: number }> {
  const uploadsDir = resolve(workdir, UPLOADS_DIR);
  await mkdir(uploadsDir, { recursive: true });

  const sanitized = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeName = `${crypto.randomUUID()}-${sanitized}`;
  const absPath = resolve(uploadsDir, safeName);

  if (!absPath.startsWith(resolve(uploadsDir) + "/")) {
    throw new Error("Path traversal detected");
  }

  await writeFile(absPath, buffer);

  return {
    path: join(UPLOADS_DIR, safeName),
    size: buffer.byteLength,
  };
}
