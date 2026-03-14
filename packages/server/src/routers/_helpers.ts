import { ORPCError } from "@orpc/server";
import { SessionCorruptError } from "../session-mgr.js";
import type { SessionManager } from "../session-mgr.js";

export function loadSessionOrThrow(sessionMgr: SessionManager, sessionId: string) {
  let session;
  try {
    session = sessionMgr.load(sessionId);
  } catch (err) {
    if (err instanceof SessionCorruptError) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: err.message });
    }
    throw err;
  }
  if (!session) {
    throw new ORPCError("NOT_FOUND", {
      message: `Session ${sessionId} not found`,
    });
  }
  return session;
}
