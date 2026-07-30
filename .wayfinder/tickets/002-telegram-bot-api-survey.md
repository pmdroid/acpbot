---
id: "002"
title: Survey the Telegram Bot API for the control surface
type: research
status: closed
assignee: research-agent (charting session)
blocked_by: []
---

## Question

The surface model and the round-trip design both hinge on what Telegram can
actually do. Establish the mechanics, with current Bot API limits and citations:

1. **Forum topics.** In a supergroup with topics enabled: can a bot create,
   rename, close, and reopen topics programmatically? Can it send to and receive
   from a specific topic? What identifies a topic, and is there a cap on how many
   a group may hold? This is the leading candidate for "one topic per session".
2. **Inline keyboards and callback queries.** How a button press is delivered, how
   long a callback query stays answerable, and what happens if the bot process
   restarts between sending the keyboard and the press. Can a message's keyboard
   be edited or removed after the fact (to mark a permission already answered)?
3. **Reply targeting.** Given a free-text reply, can the bot reliably tell *which*
   message it answers — specifically, is `reply_to_message` dependable enough to
   route a typed answer back to the right pending question?
4. **Long-polling semantics.** `getUpdates` behaviour: delivery guarantees, update
   backlog on reconnect, how long undelivered updates are retained, and whether
   updates missed while the daemon was asleep are recoverable.
5. **Hard limits.** Message length cap, edit rate limits, per-chat and global send
   rate limits, and what the API returns when they are exceeded.
6. **Bot capability prerequisites.** What must be configured on the bot (privacy
   mode, admin rights in the supergroup, `/setcommands`) for the above to work.

Limits 5 is recorded as *fact-gathering only* — the output volume policy that would
act on it is out of scope for this map. Note the numbers; do not design around them.

## Resolution

**Asset:** `research/telegram-bot-api.md` on branch `research/telegram-bot-api`
(641 lines, four incremental commits). Sourced against the live Bot API reference
**v10.2 (14 Jul 2026)**, the changelog, and the bot FAQ; community-only claims are
individually flagged low-confidence.

**Decision 1 — forum topics per session: VIABLE.** Full lifecycle exists as
first-class methods (`createForumTopic`, `editForumTopic`, `closeForumTopic`,
`reopenForumTopic`, `deleteForumTopic`). A topic is an integer `message_thread_id`;
every send method takes it and every inbound `Message` carries it plus
`is_topic_message`, so routing is clean in both directions. Shipping since Bot API
6.3 (Nov 2022) — mature.

Two consequences:

- **There is no method to list existing topics.** The daemon must own its
  `message_thread_id` → session mapping durably; it cannot re-derive it from
  Telegram.
- **A private-chat alternative now exists and may be better.** Bot API 9.3/9.4
  (Dec 2025 / Feb 2026) brought topics to the 1:1 chat with the bot
  (`getMe.has_topics_enabled`). For a single operator this skips the supergroup,
  admin rights, privacy mode, and the 20-msg/min group limit entirely, and unlocks
  `sendMessageDraft` (30-second streaming preview, private-chat only). Cost:
  `closeForumTopic`/`reopenForumTopic` were never extended to private chats —
  confirmed by their absence from both changelog entries, so not a docs oversight.
  This is now a live candidate on the surface-model ticket.

**Decision 2 — inline keyboard across restart: the decision survives, the
acknowledgement does not.** The keyboard is server-side state on the message and
stays pressable through process death. A press while the daemon is down is queued
(updates retained **24 hours**) and arrives afterwards as a normal `callback_query`
with `data` intact — so a prompt is identifiable from `callback_data` alone, with
zero in-memory state. It can then be marked answered via `editMessageReplyMarkup`
or `editMessageText`, neither of which has a documented age limit for the bot's own
messages.

**Correction the researcher made and flagged:** the widely-repeated ~15-minute
`answerCallbackQuery` window does not survive checking. Community sources
contradict each other across three orders of magnitude (10 s, 15 s, 15 min) and
every actual reproduction points at seconds. The honest answer is "short, and
unknowable from documentation", which inverts the design implication: **after a
restart, assume `answerCallbackQuery` always fails.** Operator confirmation must
come from editing the message, never from the callback answer. Bisecting the real
window is listed as the top prototype question.

**Reply targeting is dependable but not forceable.** `reply_to_message` is
server-provided, unspoofable, and carries the full original `Message` — but it is
only populated for same-chat-and-thread replies and only if the operator uses the
reply gesture. `ForceReply` nudges, it does not constrain. A three-step fallback
(reply-id → sole pending question in topic → disambiguating keyboard) is proposed
in §3.4.

**Privacy mode is a real trap on the supergroup route.** With it on (the default),
a bare typed message in a session topic is *silently dropped* — only `/cmd@bot`,
replies to the bot, and service messages arrive. Admins are exempt, and tacp needs
`can_manage_topics` admin rights anyway, so it works out by accident rather than
design. Should become a conscious startup assertion.

**Sleeping Mac:** undelivered updates are dropped after 24 h with no error and no
gap indicator. Delivery is at-least-once with offset-as-ack, so handlers must be
idempotent. The 409 single-consumer conflict matters for a launchd restart
overlapping a dying predecessor.

**Limits recorded as facts only, no policy derived** (per the map's out-of-scope
ruling): 4096-char messages, 1024-char captions, 128-char topic names; 1 msg/s per
chat, 20/min per group, ~30/s global; 429 carries `parameters.retry_after` as the
authoritative backoff signal. Also flagged `migrate_to_chat_id`, since a
group→supergroup upgrade sits on tacp's likely path and rewrites the chat id.

**One limit is binding on design rather than volume:** `callback_data` is capped at
**64 bytes**. It will not hold a file path, so permission prompts need an opaque
token indirected through tacp's own store. This is a structural input to the
round-trip ticket, not an output-volume concern.
