import type { SessionMessage } from "./types.js";

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB

// --- Message preview ---

function mediaLabel(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "[image]";
  if (mimeType.startsWith("audio/")) return "[audio]";
  if (mimeType.startsWith("video/")) return "[video]";
  return "[document]";
}

/**
 * Returns a short preview string for a session message.
 * If the message has attachments (FileRef[]), prepends a media label.
 */
export function lastMessagePreview(msg: SessionMessage): string {
  if (!msg.attachments?.length) return msg.content;

  const label = mediaLabel(msg.attachments[0].mimeType);
  return msg.content ? `${label} ${msg.content}` : label;
}
