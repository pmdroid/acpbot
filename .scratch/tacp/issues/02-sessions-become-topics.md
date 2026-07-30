# 02 — Sessions become topics, and survive restart

**What to build:** Creating a session creates a topic in the operator's private
chat named `repo/name`, and that topic *is* the session from then on. Anything the
operator types inside it is routed to that session. Killing the daemon and
restarting it recovers every session and its topic — the operator sees no loss.

Restart recovery is the substance of this ticket, not a nicety. Telegram has no
method to list topics and acpx's `AcpSessionStore` has no `list()`, so **neither
side can rebuild the session list**. tacp owns it outright, or it is gone. The
store holds the bidirectional `message_thread_id` ↔ session identity mapping, the
session list itself, and enough per-session state to restore the topic's displayed
status.

Several sessions in one repo is normal and must work — session identity is
`repo` + `name`, matching acpx's named workstreams.

**Provisional interface, deliberately.** How the operator *chooses* a repo from a
phone is wayfinder ticket 006 and is not decided. This ticket takes session
identity as given — accept it explicitly on the creation command and resolve the
repo through configuration. Do not invent a picker; ticket 006 will layer the UX
on top of this mechanism.

The root area stays commands-only. Agent output must be structurally incapable of
being emitted without a `message_thread_id`.

**Blocked by:** 01 — Authenticated daemon with a working lobby.

**Status:** ready-for-agent

- [ ] Creating a session creates a topic named `repo/name` and persists the
      mapping
- [ ] A message typed in a topic is routed to that session; a message in root is
      treated as a command
- [ ] Two sessions in the same repo coexist with separate topics and separate
      scrollbacks
- [ ] After a daemon restart, the session list and every topic mapping are
      recovered from tacp's own store
- [ ] Listing sessions returns tacp's own list, not a query to Telegram or acpx
- [ ] Agent output cannot be emitted without a thread id — enforced by
      construction, and tested
- [ ] Restart is tested by constructing a new core over the same store, not by
      restarting a process
