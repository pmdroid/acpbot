---
id: "001"
title: Probe acpx/runtime for async permission interception
type: research
status: open
assignee: null
blocked_by: []
---

## Question

The whole design rests on one assumption that has not been verified: that
`acpx/runtime` lets embedding code **intercept a permission request and answer it
later** — minutes later, from a different process context — rather than only
choosing a static policy up front.

acpx documents permission policy as a *flag* (`--approve-all`, `--approve-reads`,
`--deny-all`), which is a CLI-shaped answer. A chat client needs a callback-shaped
one. Establish, against acpx 0.13.0's actual source and type definitions:

1. **Permission interception.** Can an embedder supply a handler for ACP
   `session/request_permission`? Is it async, and is there a deadline or timeout
   that would fire before a human replies? What happens to the agent turn while
   the handler is pending?
2. **Event subscription.** How does an embedder observe a running turn — assistant
   text, thinking, tool calls, diffs, turn end? Push (events/callbacks) or pull
   (async iterator)? Is the stream resumable after the consumer goes away and
   comes back?
3. **Session API.** Creating, listing, resuming, and cancelling sessions from the
   library. What identifies a session, and where is session state stored on disk?
4. **Queueing.** The CLI queues prompts submitted mid-turn. Is that behaviour in
   the runtime library or only in the CLI layer?
5. **Multiple concurrent sessions.** Can one process hold several live sessions
   against different agents and repos at once, and is there shared mutable state
   that would make that unsafe?
6. **Portability.** Does the runtime assume a TTY, a specific cwd, or locally
   cached agent credentials? (See the map's local-first-portable-later constraint.)

Record concrete API surface — function and type names, signatures — not prose
impressions. Where the answer is "no", say what the closest available mechanism is.

If interception turns out to be impossible, that is a map-altering finding: the
substrate decision would need to be reopened.
