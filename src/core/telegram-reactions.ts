/**
 * Telegram message_reaction helpers — serialize any emoji / custom emoji
 * for the agent (no fixed thumbs-only allowlist).
 */
import type {
  MessageReactionUpdated,
  ReactionType,
} from "../env/types";

export function reactionTypeToToken(r: ReactionType): string {
  if (!r || typeof r !== "object") return "?";
  if (r.type === "emoji") {
    return (r.emoji ?? "").trim() || "emoji:?";
  }
  if (r.type === "custom_emoji") {
    const id = (r.custom_emoji_id ?? "").trim();
    return id ? `custom:${id}` : "custom:?";
  }
  if (r.type === "paid") {
    return "paid";
  }
  // Forward unknown future types raw
  try {
    return `raw:${JSON.stringify(r)}`;
  } catch {
    return "raw:?";
  }
}

export function reactionListToTokens(list: ReactionType[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.map(reactionTypeToToken).filter(Boolean);
}

function setOf(tokens: string[]): Set<string> {
  return new Set(tokens);
}

/** Tokens present in `next` but not `prev`. */
export function reactionDiffAdded(
  prev: ReactionType[] | undefined,
  next: ReactionType[] | undefined,
): string[] {
  const a = setOf(reactionListToTokens(prev));
  return reactionListToTokens(next).filter((t) => !a.has(t));
}

/** Tokens present in `prev` but not `next`. */
export function reactionDiffRemoved(
  prev: ReactionType[] | undefined,
  next: ReactionType[] | undefined,
): string[] {
  const b = setOf(reactionListToTokens(next));
  return reactionListToTokens(prev).filter((t) => !b.has(t));
}

export type ReactionOutboundContext = {
  /** Plain-text preview of the bot message that was reacted to. */
  textPreview?: string;
  textTruncated?: boolean;
  kind?: string;
};

/**
 * Synthetic user message for the agent. All emoji types are listed as-is
 * so skills (e.g. SXM learning) can map valence without host filtering.
 * Includes the outbound message preview when the host still has it indexed.
 */
export function formatTelegramReactionPrompt(
  r: MessageReactionUpdated,
  outbound?: ReactionOutboundContext,
): string {
  const oldT = reactionListToTokens(r.old_reaction);
  const newT = reactionListToTokens(r.new_reaction);
  const added = reactionDiffAdded(r.old_reaction, r.new_reaction);
  const removed = reactionDiffRemoved(r.old_reaction, r.new_reaction);
  const userId = r.user?.id;
  const actorChatId = r.actor_chat?.id;
  const preview = outbound?.textPreview?.trim();
  const lines = [
    "[telegram_reaction]",
    `message_id: ${r.message_id}`,
    `chat_id: ${r.chat.id}`,
    ...(userId !== undefined ? [`user_id: ${userId}`] : []),
    ...(actorChatId !== undefined ? [`actor_chat_id: ${actorChatId}`] : []),
    `date: ${r.date}`,
    ...(outbound?.kind ? [`message_kind: ${outbound.kind}`] : []),
    `added: ${added.length ? added.join(", ") : "(none)"}`,
    `removed: ${removed.length ? removed.join(", ") : "(none)"}`,
    `new: ${newT.length ? newT.join(", ") : "(none)"}`,
    `old: ${oldT.length ? oldT.join(", ") : "(none)"}`,
    "",
    "=== reacted_message ===",
    preview
      ? preview + (outbound?.textTruncated ? "\n…(truncated)" : "")
      : "(host has no text preview for this message_id — message may be older than the index, media-only, or from before indexing)",
    "=== end_reacted_message ===",
    "",
    "The operator reacted to the bot message above in this topic.",
    "Use this signal for preference learning when applicable",
    "(e.g. positive/negative emoji on a briefing item).",
    "Map the reaction to the content in reacted_message — do not invent other items.",
  ];
  return lines.join("\n");
}

/** True when the reaction set actually changed. */
export function reactionSetChanged(r: MessageReactionUpdated): boolean {
  const added = reactionDiffAdded(r.old_reaction, r.new_reaction);
  const removed = reactionDiffRemoved(r.old_reaction, r.new_reaction);
  return added.length > 0 || removed.length > 0;
}
