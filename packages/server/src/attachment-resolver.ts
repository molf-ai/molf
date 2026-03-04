import type {
  SessionMessage as AgentCoreSessionMessage,
  ResolvedAttachment,
} from "@molf-ai/agent-core";
import type { SessionMessage, Attachment } from "@molf-ai/protocol";
import type { InlineMediaCache } from "./inline-media-cache.js";

export const MEDIA_HINT = [
  "Users can attach files to messages. Attached files are saved in .molf/uploads/ within your working directory.",
  "Images are shown to you inline. Non-image files (PDFs, documents, audio) appear as text references.",
  "To view non-image file contents, use the read_file tool with the file path.",
  "The read_file tool can read binary files (images, PDFs, audio) and show you their contents.",
  "Uploaded files persist in the workspace and can be used by shell commands, scripts, and other tools.",
  "Video files cannot be viewed inline — use shell_exec with ffmpeg or similar tools.",
].join(" ");

export const IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml",
]);

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image-data"; data: string; mediaType: string }
  | { type: "file-data"; data: string; mediaType: string };

/** Convert an attachment to Vercel AI SDK model output parts. */
export function attachmentToContentParts(att: Attachment): ContentPart[] {
  const meta = `path: ${att.path}, type: ${att.mimeType}, size: ${att.size} bytes`;
  if (IMAGE_MIMES.has(att.mimeType)) {
    return [
      { type: "text", text: `[Binary file: ${meta}]` },
      { type: "image-data", data: att.data, mediaType: att.mimeType },
    ];
  }
  return [
    { type: "text", text: `[Binary file: ${meta}]` },
    { type: "file-data", data: att.data, mediaType: att.mimeType },
  ];
}

/** Resolve a single file reference: inline image if cached, otherwise return a text hint. */
export function resolveFileRef(
  ref: { path: string; mimeType: string },
  inlineMediaCache: InlineMediaCache,
): {
  inlined?: ResolvedAttachment;
  hint?: string;
} {
  if (ref.mimeType.startsWith("image/")) {
    const cached = inlineMediaCache.load(ref.path);
    if (cached) {
      return { inlined: { data: cached.buffer, mimeType: ref.mimeType } };
    }
  }
  return { hint: `[Attached file: ${ref.path}, ${ref.mimeType}. Use read_file to access if needed.]` };
}

/**
 * Convert protocol SessionMessages to agent-core messages, resolving attachments.
 * For each message with attachments: inlines cached images as binary data,
 * and prepends text hints for non-inlineable files to the message content.
 */
export function resolveSessionMessages(
  messages: SessionMessage[],
  inlineMediaCache: InlineMediaCache,
): AgentCoreSessionMessage[] {
  return messages.map((msg) => {
    const base: AgentCoreSessionMessage = {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      ...(msg.toolCalls && { toolCalls: msg.toolCalls }),
      ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
      ...(msg.toolName && { toolName: msg.toolName }),
      ...(msg.summary && { summary: msg.summary }),
      ...(msg.usage && { usage: msg.usage }),
      ...(msg.synthetic && { synthetic: msg.synthetic }),
    };

    if (!msg.attachments?.length) return base;

    const inlined: ResolvedAttachment[] = [];
    const hints: string[] = [];
    for (const ref of msg.attachments) {
      const resolved = resolveFileRef(ref, inlineMediaCache);
      if (resolved.inlined) inlined.push(resolved.inlined);
      if (resolved.hint) hints.push(resolved.hint);
    }

    if (inlined.length > 0) base.attachments = inlined;
    if (hints.length > 0) {
      base.content = base.content
        ? `${hints.join("\n")}\n${base.content}`
        : hints.join("\n");
    }
    return base;
  });
}
