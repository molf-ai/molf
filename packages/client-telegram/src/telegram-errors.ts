export function isParseError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("can't parse entities");
}

export function isMessageNotModified(err: unknown): boolean {
  return err instanceof Error && err.message.includes("message is not modified");
}
