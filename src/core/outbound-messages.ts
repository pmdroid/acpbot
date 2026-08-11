/**
 * Map outbound Telegram message_id → session so reactions on bot messages
 * can be routed even when message_reaction updates omit message_thread_id.
 * Also keeps a short plain-text preview so agents know *what* was reacted to.
 *
 * Persisted to disk so reactions still resolve after worker restart / cold agent.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  /** Replace in-memory state from disk snapshot (after prune). */
  importEntries(
    entries: Array<{ messageId: number } & OutboundMessageRef>,
  ): void;
  /** Snapshot for disk (already pruned). */
  exportEntries(): Array<{ messageId: number } & OutboundMessageRef>;
  /** Load JSON file if present. */
  loadFile(path: string): Promise<{ loaded: number }>;
  /** Write JSON file (best-effort). */
  saveFile(path: string): Promise<void>;
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

type FileShape = {
  version: 1;
  entries: Array<{ messageId: number } & OutboundMessageRef>;
};

export function createOutboundMessageIndex(opts?: {
  /** Max entries retained (oldest dropped). Default 5000. */
  max?: number;
  /** Drop entries older than this. Default 7d. */
  ttlMs?: number;
  /** Called after each successful record (for debounced persist). */
  onChange?: () => void;
}): OutboundMessageIndex {
  const max = Math.max(1, opts?.max ?? 5000);
  const ttlMs = Math.max(1_000, opts?.ttlMs ?? 7 * 24 * 60 * 60 * 1000);
  const byKey = new Map<string, OutboundMessageRef>();
  const order: string[] = [];

  const keyOf = (chatId: number, messageId: number) =>
    `${chatId}:${messageId}`;

  const parseKey = (
    k: string,
  ): { chatId: number; messageId: number } | undefined => {
    const i = k.lastIndexOf(":");
    if (i <= 0) return undefined;
    const chatId = Number(k.slice(0, i));
    const messageId = Number(k.slice(i + 1));
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return undefined;
    return { chatId, messageId };
  };

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
    while (order.length > max) {
      const k = order.shift()!;
      byKey.delete(k);
    }
  };

  const exportEntries = (): Array<{ messageId: number } & OutboundMessageRef> => {
    prune(Date.now());
    const out: Array<{ messageId: number } & OutboundMessageRef> = [];
    for (const k of order) {
      const ref = byKey.get(k);
      if (!ref) continue;
      const parsed = parseKey(k);
      if (!parsed) continue;
      out.push({ messageId: parsed.messageId, ...ref });
    }
    return out;
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
      opts?.onChange?.();
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
    importEntries(entries) {
      byKey.clear();
      order.length = 0;
      const now = Date.now();
      for (const e of entries) {
        if (
          typeof e.chatId !== "number" ||
          typeof e.messageId !== "number" ||
          typeof e.sessionKey !== "string" ||
          typeof e.at !== "number"
        ) {
          continue;
        }
        if (now - e.at > ttlMs) continue;
        const k = keyOf(e.chatId, e.messageId);
        if (byKey.has(k)) continue;
        order.push(k);
        byKey.set(k, {
          sessionKey: e.sessionKey,
          chatId: e.chatId,
          ...(e.messageThreadId !== undefined
            ? { messageThreadId: e.messageThreadId }
            : {}),
          kind: e.kind ?? "agent",
          at: e.at,
          ...(e.textPreview !== undefined
            ? { textPreview: e.textPreview }
            : {}),
          ...(e.textTruncated ? { textTruncated: true } : {}),
        });
      }
      prune(now);
    },
    exportEntries,
    async loadFile(path) {
      try {
        const raw = await readFile(path, "utf8");
        const data = JSON.parse(raw) as FileShape;
        if (!data || data.version !== 1 || !Array.isArray(data.entries)) {
          return { loaded: 0 };
        }
        this.importEntries(data.entries);
        return { loaded: byKey.size };
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: string }).code)
            : "";
        if (code === "ENOENT") return { loaded: 0 };
        throw err;
      }
    },
    async saveFile(path) {
      const body: FileShape = {
        version: 1,
        entries: exportEntries(),
      };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(body)}\n`, "utf8");
    },
  };
}
