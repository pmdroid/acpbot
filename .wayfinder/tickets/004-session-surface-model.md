---
id: "004"
title: Choose the session-to-Telegram surface model
type: prototype
status: open
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
