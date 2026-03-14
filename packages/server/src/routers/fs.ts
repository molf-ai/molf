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
      const rawSize = Math.floor(input.data.length * 3 / 4);
      if (rawSize > MAX_ATTACHMENT_BYTES) {
        throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "File too large (max 15MB)" });
      }

      // 2. Look up session → worker
      const session = loadSessionOrThrow(context.sessionMgr, input.sessionId);
      const worker = context.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "Worker not connected" });
      }

      // 3. Forward to worker via UploadDispatch (with timeout)
      const uploadId = `upload_${crypto.randomUUID().slice(0, 8)}`;
      let result: { path: string; size: number; error?: string };
      let timer: ReturnType<typeof setTimeout>;
      try {
        result = await Promise.race([
          context.uploadDispatch.dispatch(session.workerId, {
            uploadId,
            data: input.data,
            filename: input.filename,
            mimeType: input.mimeType,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Upload timeout")), UPLOAD_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        throw new ORPCError("TIMEOUT", { message: errorMessage(err) });
      } finally {
        clearTimeout(timer!);
      }

      if (result.error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: result.error });
      }

      // 4. Cache image bytes for inline
      if (input.mimeType.startsWith("image/")) {
        const buffer = Buffer.from(input.data, "base64");
        context.inlineMediaCache.save(result.path, new Uint8Array(buffer), input.mimeType);
      }

      return { path: result.path, mimeType: input.mimeType, size: result.size };
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
