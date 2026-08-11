/**
 * Map outbound Telegram message_id → session so reactions on bot messages
 * can be routed even when message_reaction updates omit message_thread_id.
 */
export type OutboundMessageKind = "agent" | "system" | "ui" | "media";

export type OutboundMessageRef = {
  sessionKey: string;
  chatId: number;
  messageThreadId?: number;
  kind: OutboundMessageKind;
  at: number;
};

export type OutboundMessageIndex = {
  record(input: {
    chatId: number;
    messageId: number;
    sessionKey: string;
    messageThreadId?: number;
    kind?: OutboundMessageKind;
    now?: number;
  }): void;
  lookup(
    chatId: number,
    messageId: number,
  ): OutboundMessageRef | undefined;
  size(): number;
  clear(): void;
};

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
      byKey.set(k, {
        sessionKey: input.sessionKey,
        chatId: input.chatId,
        ...(input.messageThreadId !== undefined
          ? { messageThreadId: input.messageThreadId }
          : {}),
        kind: input.kind ?? "agent",
        at: now,
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
