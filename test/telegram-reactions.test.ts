import { describe, expect, test } from "bun:test";
import { createOutboundMessageIndex } from "../src/core/outbound-messages";
import {
  formatTelegramReactionPrompt,
  reactionDiffAdded,
  reactionDiffRemoved,
  reactionSetChanged,
  reactionTypeToToken,
} from "../src/core/telegram-reactions";
import type { MessageReactionUpdated } from "../src/env/types";

describe("reactionTypeToToken", () => {
  test("unicode emoji", () => {
    expect(reactionTypeToToken({ type: "emoji", emoji: "🔥" })).toBe("🔥");
  });
  test("custom emoji id", () => {
    expect(
      reactionTypeToToken({
        type: "custom_emoji",
        custom_emoji_id: "5368324170671202286",
      }),
    ).toBe("custom:5368324170671202286");
  });
  test("paid", () => {
    expect(reactionTypeToToken({ type: "paid" })).toBe("paid");
  });
  test("unknown type still serializes", () => {
    const t = reactionTypeToToken({ type: "future_thing", emoji: "x" } as never);
    expect(t.startsWith("raw:") || t.includes("future")).toBe(true);
  });
});

describe("reaction diffs", () => {
  test("added and removed", () => {
    const oldR = [{ type: "emoji", emoji: "👍" }];
    const newR = [
      { type: "emoji", emoji: "🔥" },
      { type: "custom_emoji", custom_emoji_id: "1" },
    ];
    expect(reactionDiffAdded(oldR, newR)).toEqual(["🔥", "custom:1"]);
    expect(reactionDiffRemoved(oldR, newR)).toEqual(["👍"]);
    expect(
      reactionSetChanged({
        chat: { id: 1, type: "private" },
        message_id: 9,
        date: 1,
        old_reaction: oldR,
        new_reaction: newR,
      }),
    ).toBe(true);
  });
});

describe("formatTelegramReactionPrompt", () => {
  test("forwards all tokens without allowlist", () => {
    const r: MessageReactionUpdated = {
      chat: { id: 42, type: "private" },
      message_id: 100,
      user: { id: 7, is_bot: false, first_name: "Op" },
      date: 1_700_000_000,
      old_reaction: [{ type: "emoji", emoji: "👎" }],
      new_reaction: [
        { type: "emoji", emoji: "🥰" },
        { type: "custom_emoji", custom_emoji_id: "999" },
        { type: "emoji", emoji: "🚀" },
      ],
      message_thread_id: 55,
    };
    const text = formatTelegramReactionPrompt(r);
    expect(text).toContain("[telegram_reaction]");
    expect(text).toContain("message_id: 100");
    expect(text).toContain("user_id: 7");
    expect(text).toContain("🥰");
    expect(text).toContain("🚀");
    expect(text).toContain("custom:999");
    expect(text).toContain("removed: 👎");
    expect(text).toContain("added:");
    expect(text).toContain("=== reacted_message ===");
    expect(text).toContain("no text preview");
  });

  test("includes outbound message preview for the agent", () => {
    const r: MessageReactionUpdated = {
      chat: { id: 1, type: "private" },
      message_id: 9,
      date: 1,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    };
    const text = formatTelegramReactionPrompt(r, {
      textPreview: "1. Alice DM: deploy tonight\n2. Stripe invoice",
      kind: "agent",
    });
    expect(text).toContain("message_kind: agent");
    expect(text).toContain("Alice DM: deploy tonight");
    expect(text).toContain("Stripe invoice");
    expect(text).toContain("=== end_reacted_message ===");
  });
});

describe("outbound message index", () => {
  test("records and looks up by chat+message_id with text preview", () => {
    const idx = createOutboundMessageIndex({ max: 10, ttlMs: 60_000 });
    idx.record({
      chatId: 1,
      messageId: 50,
      sessionKey: "sxm/main",
      messageThreadId: 9,
      kind: "agent",
      text: "<b>Brief</b>\n• liked item",
    });
    const hit = idx.lookup(1, 50);
    expect(hit?.sessionKey).toBe("sxm/main");
    expect(hit?.messageThreadId).toBe(9);
    expect(hit?.textPreview).toContain("Brief");
    expect(hit?.textPreview).toContain("liked item");
    expect(hit?.textPreview).not.toContain("<b>");
    expect(idx.lookup(1, 99)).toBeUndefined();
  });

  test("evicts oldest when over max", () => {
    const idx = createOutboundMessageIndex({ max: 3, ttlMs: 60_000 });
    for (let i = 1; i <= 5; i++) {
      idx.record({
        chatId: 1,
        messageId: i,
        sessionKey: `s/${i}`,
      });
    }
    expect(idx.size()).toBe(3);
    expect(idx.lookup(1, 1)).toBeUndefined();
    expect(idx.lookup(1, 5)?.sessionKey).toBe("s/5");
  });
});
