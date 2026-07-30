---
id: "002"
title: Survey the Telegram Bot API for the control surface
type: research
status: open
assignee: null
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
