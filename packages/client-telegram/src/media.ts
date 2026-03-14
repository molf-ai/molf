import type { Context } from "grammy";
import { MAX_ATTACHMENT_BYTES } from "@molf-ai/protocol";

export interface DownloadedMedia {
  buffer: Uint8Array;
  mimeType: string;
  filename: string;
}

/**
 * Detect the file ID, mimeType, filename, and size from a Telegram message.
 * Returns null if the message doesn't contain supported media.
 */
function detectMedia(ctx: Context): {
  fileId: string;
  mimeType: string;
  filename: string;
  fileSize?: number;
} | null {
  const msg = ctx.message;
  if (!msg) return null;

  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    return {
      fileId: photo.file_id,
      mimeType: "image/jpeg",
      filename: "photo.jpg",
      fileSize: photo.file_size,
    };
  }

  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      mimeType: msg.document.mime_type ?? "application/octet-stream",
      filename: msg.document.file_name ?? "document",
      fileSize: msg.document.file_size,
    };
  }

  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      mimeType: msg.audio.mime_type ?? "audio/mpeg",
      filename: msg.audio.file_name ?? "audio.mp3",
      fileSize: msg.audio.file_size,
    };
  }

  if (msg.voice) {
    return {
      fileId: msg.voice.file_id,
      mimeType: msg.voice.mime_type ?? "audio/ogg",
      filename: "voice.ogg",
      fileSize: msg.voice.file_size,
    };
  }

  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      mimeType: msg.video.mime_type ?? "video/mp4",
      filename: msg.video.file_name ?? "video.mp4",
      fileSize: msg.video.file_size,
    };
  }

  if (msg.video_note) {
    return {
      fileId: msg.video_note.file_id,
      mimeType: "video/mp4",
      filename: "video_note.mp4",
      fileSize: msg.video_note.file_size,
    };
  }

  if (msg.sticker) {
    return {
      fileId: msg.sticker.file_id,
      mimeType: msg.sticker.is_animated ? "application/x-tgsticker" : "image/webp",
      filename: "sticker.webp",
      fileSize: msg.sticker.file_size,
    };
  }

  return null;
}

/**
 * Download media from a Telegram message.
 * Validates file size before downloading.
 * Throws if the file is too large or media type is unsupported.
 */
export async function downloadTelegramMedia(
  ctx: Context,
  botToken: string,
): Promise<DownloadedMedia> {
  const media = detectMedia(ctx);
  if (!media) {
    throw new Error("No supported media found in message");
  }

  // Pre-download size check
  if (media.fileSize && media.fileSize > MAX_ATTACHMENT_BYTES) {
    throw new FileTooLargeError(media.mimeType, media.fileSize, MAX_ATTACHMENT_BYTES);
  }

  // Get file info from Telegram
  let file;
  try {
    file = await ctx.api.getFile(media.fileId);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "description" in err &&
      String((err as any).description).includes("file is too big")
    ) {
      throw new TelegramFileTooLargeError();
    }
    throw err;
  }
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  // Download the file
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download media: HTTP ${response.status}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());

  // Post-download size validation (in case Telegram metadata was missing or inaccurate)
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new FileTooLargeError(media.mimeType, buffer.byteLength, MAX_ATTACHMENT_BYTES);
  }

  return { buffer, mimeType: media.mimeType, filename: media.filename };
}

export class TelegramFileTooLargeError extends Error {
  constructor() {
    super("This file is too large for Telegram's Bot API. Try sending a smaller file.");
    this.name = "TelegramFileTooLargeError";
  }
}

export class FileTooLargeError extends Error {
  constructor(
    public mimeType: string,
    public actualSize: number,
    public maxSize: number,
  ) {
    const maxMB = Math.round(maxSize / (1024 * 1024));
    super(`File too large. Maximum for this type is ${maxMB}MB.`);
    this.name = "FileTooLargeError";
  }
}
