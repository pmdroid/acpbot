---
id: "004"
title: Choose the session-to-Telegram surface model
type: prototype
status: open
assignee: null
blocked_by: ["002"]
---

## Question

How does "switch between sessions" physically work in Telegram? This is the
highest-leverage decision on the map — message routing, notification behaviour,
how much state the operator can see at a glance, and the shape of the permission
round-trip all follow from it.

The candidates, to be made concrete rather than argued:

- **One forum topic per session** in a supergroup. Switching sessions is switching
  topics — Telegram's own UI does the navigation, each session keeps its own
  scrollback, and per-topic mute works. Cost: requires a supergroup with topics,
  and topic lifecycle must track session lifecycle.
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
close, get archived, or persist for scrollback?

Link the prototype as an asset on this ticket.
