/**
 * Detect MCP/tool names for Telegram outbound tools
 * (update / telegram_send / photo / file).
 */

const UPDATE_TOOL = /^(update|progress|status_update|notify)$/i;
const MESSAGE_TOOL =
  /^(telegram_send|telegram_message|send_message|message_user|chat_send)$/i;
const PHOTO_TOOL =
  /^(telegram_send_photo|telegram_photo|send_photo|send_image)$/i;
const FILE_TOOL =
  /^(telegram_send_file|telegram_send_document|telegram_file|telegram_document|send_file|send_document)$/i;

/** Last tool segment: mcp__tacp__telegram_send → telegram_send; tacp:update → update. */
function toolBaseName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes("__")) {
    const parts = trimmed.split("__").filter(Boolean);
    return parts[parts.length - 1] ?? trimmed;
  }
  const parts = trimmed.split(/[\/:]+/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

export function isTelegramUpdateToolName(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  const base = toolBaseName(trimmed);
  return UPDATE_TOOL.test(base) || UPDATE_TOOL.test(trimmed);
}

export function isTelegramMessageToolName(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  const base = toolBaseName(trimmed);
  return MESSAGE_TOOL.test(base) || MESSAGE_TOOL.test(trimmed);
}

export function isTelegramPhotoToolName(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  const base = toolBaseName(trimmed);
  return PHOTO_TOOL.test(base) || PHOTO_TOOL.test(trimmed);
}

export function isTelegramFileToolName(name: string | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  const base = toolBaseName(trimmed);
  return FILE_TOOL.test(base) || FILE_TOOL.test(trimmed);
}

/** True if any Telegram text MCP tool (update or send). */
export function isTelegramTextToolName(name: string | undefined): boolean {
  return isTelegramUpdateToolName(name) || isTelegramMessageToolName(name);
}

/** True if any Telegram outbound MCP tool that uses the telegram queue. */
export function isTelegramOutboundToolName(name: string | undefined): boolean {
  return (
    isTelegramTextToolName(name) ||
    isTelegramPhotoToolName(name) ||
    isTelegramFileToolName(name)
  );
}

/** Extract text from common tool input shapes. */
export function telegramTextFromToolInput(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t || undefined;
  }
  if (typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  for (const key of [
    "text",
    "message",
    "content",
    "update",
    "status",
    "body",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (o.arguments && typeof o.arguments === "object") {
    return telegramTextFromToolInput(o.arguments);
  }
  if (o.input && typeof o.input === "object") {
    return telegramTextFromToolInput(o.input);
  }
  return undefined;
}
