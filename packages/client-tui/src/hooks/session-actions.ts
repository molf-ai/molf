import type { DisplayMessage } from "../types.js";

export function wrapError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function createUserMessage(text: string): DisplayMessage {
  return {
    id: `pending_${Date.now()}`,
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

export function createSystemMessage(content: string): DisplayMessage {
  return {
    id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: "system",
    content,
    timestamp: Date.now(),
  };
}

export function validateSendPreconditions(
  text: string,
  hasConnection: boolean,
  hasSession: boolean,
): { ok: true } | { ok: false; reason: "empty" } | { ok: false; reason: "error"; error: Error } {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (!hasConnection || !hasSession) {
    return {
      ok: false,
      reason: "error",
      error: new Error(
        !hasSession
          ? "No session established. Check server connection and worker status."
          : "Not connected to server.",
      ),
    };
  }
  return { ok: true };
}

export function selectWorker(
  workers: Array<{ workerId: string }>,
  errorMessage?: string,
): { workerId: string } | { error: Error } {
  if (workers.length === 0) {
    return {
      error: new Error(
        errorMessage ??
          "No workers connected. Start a worker first:\n  molf worker --name <name> --token <token>",
      ),
    };
  }
  return { workerId: workers[0].workerId };
}

export function selectWorkerById(
  workers: Array<{ workerId: string; name: string }>,
  workerId: string,
): { workerId: string; name: string } | { error: Error } {
  const worker = workers.find((w) => w.workerId === workerId);
  if (!worker) {
    return { error: new Error(`Worker ${workerId} not found or not connected.`) };
  }
  return { workerId: worker.workerId, name: worker.name };
}
