import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "../context.js";
import { loadSessionOrThrow } from "./_helpers.js";
import { MAX_ATTACHMENT_BYTES, errorMessage } from "@molf-ai/protocol";
import type { FsReadRequest } from "@molf-ai/protocol";

const UPLOAD_TIMEOUT_MS = 30_000;

export const fsHandlers = {
  upload: os.fs.upload
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      // 1. Validate size
      if (input.file.size > MAX_ATTACHMENT_BYTES) {
        throw new ORPCError("PAYLOAD_TOO_LARGE", { message: `File too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)` });
      }

      // 2. Look up session → worker
      const session = loadSessionOrThrow(context.sessionMgr, input.sessionId);
      const worker = context.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "Worker not connected" });
      }

      // 3. Read image bytes for inline cache (before staging, while we have the File)
      const mimeType = input.file.type || "application/octet-stream";
      const filename = input.file.name || "upload";
      const isImage = mimeType.startsWith("image/");
      const imageBuffer = isImage
        ? new Uint8Array(await input.file.arrayBuffer())
        : undefined;

      // 4. Stage file to disk for worker to pull
      const uploadId = `upload_${crypto.randomUUID().slice(0, 8)}`;
      await context.uploadDispatch.stageFile(uploadId, input.file, session.workerId);

      // 5. Dispatch metadata-only to worker via iterator (with timeout)
      let result: { path: string; size: number; error?: string };
      let timer: ReturnType<typeof setTimeout>;
      try {
        result = await Promise.race([
          context.uploadDispatch.dispatch(session.workerId, {
            uploadId,
            filename,
            mimeType,
            size: input.file.size,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Upload timeout")), UPLOAD_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        context.uploadDispatch.deleteStaged(uploadId);
        throw new ORPCError("TIMEOUT", { message: errorMessage(err) });
      } finally {
        clearTimeout(timer!);
      }

      if (result.error) {
        context.uploadDispatch.deleteStaged(uploadId);
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: result.error });
      }

      // 6. Cache image for inline re-inlining
      if (imageBuffer) {
        context.inlineMediaCache.save(result.path, imageBuffer, mimeType);
      }

      return { path: result.path, mimeType, size: result.size };
    }),

  read: os.fs.read
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const session = loadSessionOrThrow(context.sessionMgr, input.sessionId);

      const worker = context.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "Worker not connected" });
      }

      const request: FsReadRequest = {
        requestId: `fs_${crypto.randomUUID().slice(0, 8)}`,
        outputId: input.outputId,
        path: input.path,
      };

      let result;
      try {
        result = await context.fsDispatch.dispatch(session.workerId, request);
      } catch (err) {
        if (err instanceof Error && err.message.includes("timeout")) {
          throw new ORPCError("TIMEOUT", { message: "File read timed out" });
        }
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(err) });
      }

      if (result.error) {
        if (result.error.toLowerCase().includes("disconnect")) {
          throw new ORPCError("PRECONDITION_FAILED", { message: result.error });
        }
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: result.error });
      }

      return {
        content: result.content,
        size: result.size,
        encoding: result.encoding,
      };
    }),
};
