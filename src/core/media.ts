/**
 * Inbound Telegram media → agent prompt text + ACP attachments + saved files.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PromptAttachment,
  SpeechPort,
  TelegramMessage,
  TelegramPort,
} from "../env/types";

export type InboundMediaKind =
  | "photo"
  | "document"
  | "voice"
  | "audio"
  | "video"
  | "video_note"
  | "sticker";

export type ResolvedInboundMedia = {
  kind: InboundMediaKind;
  fileId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Saved under session inbox when not attached as ACP image/audio */
  savedPath?: string;
};

export type PreparedAgentMedia = {
  /** Combined caption + STT + file notes */
  text: string;
  attachments: PromptAttachment[];
  /** Human-readable notes for logs / operator */
  notes: string[];
};

export function messageHasMedia(msg: TelegramMessage): boolean {
  return Boolean(
    msg.photo?.length ||
      msg.document ||
      msg.voice ||
      msg.audio ||
      msg.video ||
      msg.video_note ||
      msg.sticker,
  );
}

export function messageTextOrCaption(msg: TelegramMessage): string {
  return (msg.text ?? msg.caption ?? "").trim();
}

/** Pick the best Telegram file ref from a message (largest photo, etc.). */
export function pickMediaRef(
  msg: TelegramMessage,
):
  | { kind: InboundMediaKind; fileId: string; filename?: string; mimeType?: string }
  | undefined {
  if (msg.photo && msg.photo.length > 0) {
    const best = [...msg.photo].sort(
      (a, b) => (b.file_size ?? 0) - (a.file_size ?? 0),
    )[0]!;
    return {
      kind: "photo",
      fileId: best.file_id,
      filename: "photo.jpg",
      mimeType: "image/jpeg",
    };
  }
  if (msg.voice) {
    return {
      kind: "voice",
      fileId: msg.voice.file_id,
      filename: "voice.ogg",
      mimeType: msg.voice.mime_type ?? "audio/ogg",
    };
  }
  if (msg.audio) {
    return {
      kind: "audio",
      fileId: msg.audio.file_id,
      filename: msg.audio.file_name ?? "audio",
      mimeType: msg.audio.mime_type ?? "audio/mpeg",
    };
  }
  if (msg.document) {
    return {
      kind: "document",
      fileId: msg.document.file_id,
      filename: msg.document.file_name ?? "file",
      mimeType: msg.document.mime_type ?? "application/octet-stream",
    };
  }
  if (msg.video) {
    return {
      kind: "video",
      fileId: msg.video.file_id,
      filename: msg.video.file_name ?? "video.mp4",
      mimeType: msg.video.mime_type ?? "video/mp4",
    };
  }
  if (msg.video_note) {
    return {
      kind: "video_note",
      fileId: msg.video_note.file_id,
      filename: "video_note.mp4",
      mimeType: "video/mp4",
    };
  }
  if (msg.sticker) {
    return {
      kind: "sticker",
      fileId: msg.sticker.file_id,
      filename: "sticker.webp",
      mimeType: "image/webp",
    };
  }
  return undefined;
}

function bytesToBase64(data: Uint8Array): string {
  // Bun / Node Buffer
  return Buffer.from(data).toString("base64");
}

async function saveToInbox(
  sessionCwd: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const inbox = join(sessionCwd, ".tacp-inbox");
  await mkdir(inbox, { recursive: true });
  const savedPath = join(inbox, `${Date.now()}-${filename}`);
  await writeFile(savedPath, bytes);
  return savedPath;
}

/**
 * Download Telegram media, optionally STT voice, save files for the agent.
 *
 * ACP image/audio *content blocks* are only used when `acpMediaAttachments`
 * is true. Grok Build's ACP agent currently does **not** advertise
 * `promptCapabilities.image` / `.audio`, so acpx rejects those blocks with:
 *   "prompt[n] image content requires agentCapabilities.promptCapabilities.image"
 * Default is therefore: save to `.tacp-inbox/` + path in text (agent tools).
 */
export async function prepareAgentMedia(input: {
  msg: TelegramMessage;
  telegram: TelegramPort;
  sessionCwd: string;
  speech?: SpeechPort;
  /**
   * When true, also send image/* / audio/* as ACP prompt blocks.
   * Requires the agent to advertise promptCapabilities.image/audio.
   * Default false (safe for grok-build).
   */
  acpMediaAttachments?: boolean;
}): Promise<PreparedAgentMedia> {
  const notes: string[] = [];
  const attachments: PromptAttachment[] = [];
  const acpBlocks = input.acpMediaAttachments === true;
  const caption = messageTextOrCaption(input.msg);
  const parts: string[] = [];
  if (caption) parts.push(caption);

  const ref = pickMediaRef(input.msg);
  if (!ref) {
    return { text: caption, attachments: [], notes };
  }

  if (!input.telegram.downloadFile) {
    notes.push("Telegram download not available; media skipped.");
    return {
      text: parts.join("\n\n") || "[media received but download unavailable]",
      attachments: [],
      notes,
    };
  }

  const bytes = await input.telegram.downloadFile(ref.fileId);
  const mime = ref.mimeType ?? "application/octet-stream";
  const filename = sanitizeFilename(ref.filename ?? "file");

  // Voice / audio → STT when possible; file on disk; optional ACP audio block
  if (ref.kind === "voice" || ref.kind === "audio") {
    if (input.speech?.stt) {
      try {
        const transcript = await input.speech.stt(bytes, {
          mimeType: mime,
          filename,
        });
        if (transcript.trim()) {
          parts.push(`[voice transcript]\n${transcript.trim()}`);
          notes.push(`stt ok (${transcript.length} chars)`);
        }
      } catch (err) {
        notes.push(
          `stt failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      notes.push("stt unavailable (no speech provider)");
    }
    const savedPath = await saveToInbox(input.sessionCwd, filename, bytes);
    parts.push(
      `[audio file for agent]\npath: ${savedPath}\nmime: ${mime}\nsize: ${bytes.byteLength}`,
    );
    notes.push(`saved ${savedPath}`);
    if (acpBlocks && (mime.startsWith("audio/") || ref.kind === "voice")) {
      attachments.push({
        mediaType: mime.startsWith("audio/") ? mime : "audio/ogg",
        data: bytesToBase64(bytes),
        filename,
      });
      notes.push("acp audio attachment enabled");
    }
  } else if (
    ref.kind === "photo" ||
    ref.kind === "sticker" ||
    mime.startsWith("image/")
  ) {
    const savedPath = await saveToInbox(input.sessionCwd, filename, bytes);
    parts.push(
      `[image saved for agent]\npath: ${savedPath}\nmime: ${mime}\nsize: ${bytes.byteLength}\n` +
        `Please read/use this image file (e.g. open the path or describe it) and follow the user request above.`,
    );
    notes.push(`saved ${savedPath}`);
    if (acpBlocks) {
      attachments.push({
        mediaType: mime.startsWith("image/") ? mime : "image/jpeg",
        data: bytesToBase64(bytes),
        filename,
      });
      notes.push("acp image attachment enabled");
    } else {
      notes.push(
        "acp image blocks off (agent lacks promptCapabilities.image; using inbox path)",
      );
    }
  } else {
    const savedPath = await saveToInbox(input.sessionCwd, filename, bytes);
    parts.push(
      `[file saved for agent]\npath: ${savedPath}\nmime: ${mime}\nsize: ${bytes.byteLength}`,
    );
    notes.push(`saved ${savedPath}`);
  }

  const text =
    parts.join("\n\n").trim() ||
    (attachments.length > 0
      ? "[media attached]"
      : "[empty media message]");

  return { text, attachments, notes };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 120) || "file";
}

/** Cap TTS length so we don't blow tokens/cost. */
export function textForTts(text: string, maxChars = 1500): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars - 1)}…`;
}
