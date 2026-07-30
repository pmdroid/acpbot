---
id: "004"
title: Choose the session-to-Telegram surface model
type: prototype
status: closed
assignee: pascal (this session)
blocked_by: ["002"]
---

## Question

How does "switch between sessions" physically work in Telegram? This is the
highest-leverage decision on the map — message routing, notification behaviour,
how much state the operator can see at a glance, and the shape of the permission
round-trip all follow from it.

The candidates, to be made concrete rather than argued. All four are confirmed
viable by [Survey the Telegram Bot API for the control surface](002-telegram-bot-api-survey.md)
— zoom there for the API mechanics before choosing.

- **One topic per session in the bot's private chat** — *added after the Telegram
  survey; likely the front-runner.* Bot API 9.3/9.4 brought topics to the 1:1 chat
  (`getMe.has_topics_enabled`). For a single operator this skips the supergroup,
  admin rights, privacy mode, and the 20-msg/min group limit entirely, and unlocks
  `sendMessageDraft`. Cost: `closeForumTopic`/`reopenForumTopic` were never
  extended to private chats, so "what happens when a session ends" has fewer
  moves available — which makes the last question on this ticket sharper, not
  looser.
- **One forum topic per session in a supergroup.** Same navigation benefit, mature
  since Bot API 6.3, and topic close/reopen genuinely exists. Cost: requires
  provisioning a supergroup, granting `can_manage_topics`, and consciously
  handling privacy mode — with it on, a bare typed message in a topic is *silently
  dropped*. Also inherits the 20-msg/min group cap and the `migrate_to_chat_id`
  hazard if a group is upgraded.
- **One chat, explicit `/switch`.** A single conversation with a current-session
  pointer. Simplest to build. Cost: all sessions interleave in one scrollback, and
  the operator must hold "which session am I talking to" in their head — the exact
  failure mode that makes a wrong permission approval possible.
- **One chat per session** via separate bots or a chat-per-repo arrangement.
  Strong isolation, awkward provisioning.

Resolve by **prototyping the operator's experience** — mock the actual message
flow for a realistic scenario: two sessions running in different repos, one asking
permission while the other streams output, and the operator switching between them.
An outline or a static mock of the chat transcript is enough; this does not need a
running bot.

The prototype must make visible: how the operator knows which session a message
belongs to, how they retarget their next prompt, and what a wrong-session
mistake looks like.

Decide also what happens to the surface when a session ends — does the topic
close, get archived, or persist for scrollback? Note that the answer differs by
candidate: close/reopen exist for supergroup topics but not private-chat ones.

One fact that constrains every candidate: **Telegram offers no way to list
existing topics.** Whatever surface is chosen, tacp must durably own its
`message_thread_id` → session mapping — it can never be re-derived from Telegram
after a restart.

Link the prototype as an asset on this ticket.

## Resolution

**Asset:** [`assets/004-surface-model-mock.md`](../assets/004-surface-model-mock.md)
— the two-sessions-at-once scenario the ticket demanded, rendered as concrete
chat transcripts.

**Decided: one topic per session, in the bot's private chat.**

| | |
|---|---|
| **Where** | Topics in the 1:1 chat with the bot. No supergroup, no admin rights, no privacy-mode trap, and 1 msg/s instead of the group's 20/min. |
| **Topic =** | One ACP session, identified as `repo/name`. Several per repo is normal, matching acpx's `-s <name>` workstreams. |
| **Status** | Topic name rewritten via `editForumTopic` on every transition: running / waiting-on-you / idle / done / failed. The topic list is the dashboard. |
| **Retire** | Rename + icon swap. **Never** auto-delete. Deletion is a separate explicitly-confirmed command, because `deleteForumTopic` destroys the topic and every message in it. |
| **Root area** | Lobby: control commands only. Agent output never appears there, so nothing outside a topic is ever ambiguous about which session it belongs to. |

**Switching is navigation.** The operator taps a topic; that is the whole
interaction. No `/switch`, no current-session pointer, no mode to remember.

**Wrong-session safety became structural rather than procedural.** This was the
decisive argument against the one-chat option, where the failure is invisible —
you answer "yes" believing you are in session A while the pointer is on B, and
nothing on screen contradicts you. Here a permission prompt, its buttons, and its
diff all live in the topic they belong to, and there is no ambient current session
to go stale. Two narrower risks survive and are carried into the round-trip
ticket: a stale-but-live button in an old topic, and a lock-screen notification
read without context — which is why the topic name must always be `repo/name`,
never the bare session name.

**Four commitments this imposes:**

1. **tacp owns the `message_thread_id` → session mapping durably.** Telegram
   cannot enumerate topics and `AcpSessionStore` has no `list()`, so neither side
   can rebuild it after a restart. This is now a hard requirement, not a
   preference.
2. **An `editForumTopic` call on every state transition.** Recorded as a fact; any
   batching or suppression policy would be output-volume work, which is out of
   scope.
3. **Startup asserts `getMe.has_topics_enabled`** and refuses to run otherwise.
   Topic mode in private chats is enabled through @BotFather, not the API, so the
   daemon cannot provision it and must not degrade silently.
4. **Root-area handling is commands-only**, structurally preventing agent output
   from being emitted without a `message_thread_id`.

**Recorded risk — the API is young.** Private-chat topics landed in Bot API 9.3
(31 Dec 2025) and bot-created topics only in 9.4 (9 Feb 2026) — roughly five
months old, against three years for supergroup topics. If older Telegram clients
render them poorly, migration means recreating every session's surface.
**Supergroup topics remain the conservative fallback**, and nothing else decided
in this ticket depends on which of the two was chosen: granularity, status
signalling, retirement, and lobby semantics all port unchanged. The only delta is
that the supergroup route regains `closeForumTopic`/`reopenForumTopic` as a real
archive signal, and must then handle privacy mode and the 20 msg/min cap.

**Explicitly not decided here** (deliberately left to their own tickets): the
repo picker's contents and session-creation mechanics belong to
[Design repo selection and session lifecycle](006-repo-selection-session-lifecycle.md);
the permission button vocabulary, diff preview, and timeout behaviour belong to
[Design the permission and question round-trip](005-permission-question-round-trip.md).
The mock shows both only far enough to prove routing works.
