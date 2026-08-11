/**
 * Map outbound Telegram message_id → session so reactions on bot messages
 * can be routed even when message_reaction updates omit message_thread_id.
 * Also keeps a short plain-text preview so agents know *what* was reacted to.
 */
export type OutboundMessageKind = "agent" | "system" | "ui" | "media";

/** Cap stored preview so the index stays light. */
export const OUTBOUND_TEXT_PREVIEW_MAX = 1500;

export type OutboundMessageRef = {
  sessionKey: string;
  chatId: number;
  messageThreadId?: number;
  kind: OutboundMessageKind;
  at: number;
  /** Plain-text preview of what we sent (HTML stripped). */
  textPreview?: string;
  /** True if textPreview was truncated. */
  textTruncated?: boolean;
};

export type OutboundMessageIndex = {
  record(input: {
    chatId: number;
    messageId: number;
    sessionKey: string;
    messageThreadId?: number;
    kind?: OutboundMessageKind;
    /** Raw or HTML body of this Telegram message chunk. */
    text?: string;
    now?: number;
  }): void;
  lookup(
    chatId: number,
    messageId: number,
  ): OutboundMessageRef | undefined;
  size(): number;
  clear(): void;
};

/** Strip common Telegram HTML and collapse whitespace for previews. */
export function plainOutboundPreview(
  text: string | undefined,
  max = OUTBOUND_TEXT_PREVIEW_MAX,
): { preview?: string; truncated: boolean } {
  if (!text?.trim()) return { truncated: false };
  let plain = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!plain) return { truncated: false };
  if (plain.length <= max) return { preview: plain, truncated: false };
  return { preview: plain.slice(0, max), truncated: true };
}

export function createOutboundMessageIndex(opts?: {
  /** Max entries retained (oldest dropped). Default 5000. */
  max?: number;
  /** Drop entries older than this. Default 7d. */
  ttlMs?: number;
}): OutboundMessageIndex {
  const max = Math.max(1, opts?.max ?? 5000);
  const ttlMs = Math.max(1_000, opts?.ttlMs ?? 7 * 24 * 60 * 60 * 1000);
  const byKey = new Map<string, OutboundMessageRef>();
  const order: string[] = [];

  const keyOf = (chatId: number, messageId: number) =>
    `${chatId}:${messageId}`;

  const prune = (now: number) => {
    while (order.length > 0) {
      const k = order[0]!;
      const ref = byKey.get(k);
      if (!ref) {
        order.shift();
        continue;
      }
      if (now - ref.at > ttlMs || order.length > max) {
        byKey.delete(k);
        order.shift();
        continue;
      }
      break;
    }
    // Cap hard even if all fresh
    while (order.length > max) {
      const k = order.shift()!;
      byKey.delete(k);
    }
  };

  return {
    record(input) {
      const now = input.now ?? Date.now();
      const k = keyOf(input.chatId, input.messageId);
      if (!byKey.has(k)) order.push(k);
      const { preview, truncated } = plainOutboundPreview(input.text);
      byKey.set(k, {
        sessionKey: input.sessionKey,
        chatId: input.chatId,
        ...(input.messageThreadId !== undefined
          ? { messageThreadId: input.messageThreadId }
          : {}),
        kind: input.kind ?? "agent",
        at: now,
        ...(preview !== undefined ? { textPreview: preview } : {}),
        ...(truncated ? { textTruncated: true } : {}),
      });
      prune(now);
    },
    lookup(chatId, messageId) {
      const ref = byKey.get(keyOf(chatId, messageId));
      if (!ref) return undefined;
      if (Date.now() - ref.at > ttlMs) {
        byKey.delete(keyOf(chatId, messageId));
        return undefined;
      }
      return ref;
    },
    size: () => byKey.size,
    clear() {
      byKey.clear();
      order.length = 0;
    },
  };
}
