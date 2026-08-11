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

/**
 * Synthetic user message for the agent. All emoji types are listed as-is
 * so skills (e.g. SXM learning) can map valence without host filtering.
 */
export function formatTelegramReactionPrompt(
  r: MessageReactionUpdated,
): string {
  const oldT = reactionListToTokens(r.old_reaction);
  const newT = reactionListToTokens(r.new_reaction);
  const added = reactionDiffAdded(r.old_reaction, r.new_reaction);
  const removed = reactionDiffRemoved(r.old_reaction, r.new_reaction);
  const userId = r.user?.id;
  const actorChatId = r.actor_chat?.id;
  const lines = [
    "[telegram_reaction]",
    `message_id: ${r.message_id}`,
    `chat_id: ${r.chat.id}`,
    ...(userId !== undefined ? [`user_id: ${userId}`] : []),
    ...(actorChatId !== undefined ? [`actor_chat_id: ${actorChatId}`] : []),
    `date: ${r.date}`,
    `added: ${added.length ? added.join(", ") : "(none)"}`,
    `removed: ${removed.length ? removed.join(", ") : "(none)"}`,
    `new: ${newT.length ? newT.join(", ") : "(none)"}`,
    `old: ${oldT.length ? oldT.join(", ") : "(none)"}`,
    "",
    "The operator reacted to a bot message in this topic.",
    "Use this signal for preference learning when applicable",
    "(e.g. positive/negative emoji on a briefing item).",
    "Do not invent which brief item was meant if unclear — ask or map via message context.",
  ];
  return lines.join("\n");
}

/** True when the reaction set actually changed. */
export function reactionSetChanged(r: MessageReactionUpdated): boolean {
  const added = reactionDiffAdded(r.old_reaction, r.new_reaction);
  const removed = reactionDiffRemoved(r.old_reaction, r.new_reaction);
  return added.length > 0 || removed.length > 0;
}
