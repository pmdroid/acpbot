/**
 * Detect MCP/tool names for Telegram text tools (update / telegram_send).
 */

const UPDATE_TOOL = /^(update|progress|status_update|notify)$/i;
const MESSAGE_TOOL =
  /^(telegram_send|telegram_message|send_message|message_user|chat_send)$/i;

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

/** True if any Telegram text MCP tool (update or send). */
export function isTelegramTextToolName(name: string | undefined): boolean {
  return isTelegramUpdateToolName(name) || isTelegramMessageToolName(name);
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
