---
id: "008"
title: Provision the Telegram bot and enable private-chat topic mode
type: task
status: open
assignee: null
blocked_by: []
---

## Question

Nothing to decide — manual work that a decision waits on. The surface model
committed tacp to private-chat topics, an API surface roughly five months old, and
the round-trip ticket cannot be prototyped honestly against a mock. A real bot is
needed to react to.

**HITL — the operator must do steps 1–3 personally; @BotFather is not scriptable.**

1. **Create the bot** via @BotFather. Record the token somewhere the daemon can
   read it *without* assuming a path on this Mac — the map's portability
   constraint applies. Note where it was put; later tickets depend on knowing.
2. **Enable topic mode in private chats** on the bot via @BotFather. This is a
   BotFather setting, not an API call — the daemon can never provision it, only
   assert it.
3. **Record the operator's own Telegram user id** — the single-entry allowlist.

Then, verifiable by agent:

4. **Confirm `getMe` reports `has_topics_enabled: true`** (and note
   `allows_users_to_create_topics`). This is the exact assertion the daemon will
   make at startup.
5. **Create, rename, and delete a throwaway topic** via `createForumTopic` /
   `editForumTopic` / `deleteForumTopic` against the private chat. Confirms
   bot-created topics in private chats actually work on this account, and that the
   status-in-the-name mechanism renders acceptably on the operator's client.
6. **Send an inline keyboard, kill the process, press the button, restart, and
   read the queued `callback_query`.** Confirms the restart-recovery premise the
   round-trip design rests on.
7. **Bisect the real `answerCallbackQuery` expiry window.** The Telegram survey
   found community sources contradicting each other across three orders of
   magnitude (10 s / 15 s / 15 min) and flagged this as the top empirical
   question. Measure it. The design already assumes the pessimistic case — this
   confirms whether that assumption is merely safe or actually necessary.

**Resolution records:** where the token and user id live, the `getMe` flags
observed, whether the topic lifecycle behaved as documented, and the measured
callback window. Also note the Telegram client version tested, since the API's
youth is a recorded risk on the surface-model ticket.

Do not build any part of tacp here. This ticket ends when a bot exists and its
behaviour is known.
