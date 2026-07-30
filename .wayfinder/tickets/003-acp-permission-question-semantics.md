---
id: "003"
title: Pin down ACP permission and question semantics
type: research
status: open
assignee: research-agent (charting session)
blocked_by: []
---

## Question

The operator asked for two things that may or may not be the same thing in the
protocol: **permission requests** ("may I write this file?") and **questions to
answer** ("which of these two approaches do you want?"). Before designing a
round-trip, establish what the Agent Client Protocol itself defines.

Against the ACP specification and schema:

1. **`session/request_permission`.** Its exact shape — what options an agent
   offers, whether options are free-form or an enumerated kind, what metadata
   accompanies the request (tool name, arguments, diff, affected paths), and what
   a valid response looks like.
2. **Is there a distinct "ask the user a question" primitive?** Or does a
   clarifying question arrive as ordinary assistant text with the turn simply
   ending — meaning tacp cannot distinguish it from commentary without heuristics?
   This distinction decides whether question-answering is a protocol feature or
   something tacp must infer.
3. **Turn lifecycle.** How a turn starts, streams, and ends; how cancellation
   (`session/cancel`) is expressed; whether a turn can be blocked awaiting a
   permission response indefinitely, or whether the protocol implies a deadline.
4. **Tool call representation.** How tool calls, their status transitions, and
   diffs appear in the event stream — enough to know what tacp *could* surface.
5. **Agent variation.** Where Codex and Claude differ in which of these they
   actually implement, since the spec must not assume uniform support.

Cite the spec and schema; where behaviour is implementation-defined rather than
specified, say so explicitly — that is exactly where the spec will need to make a
choice rather than follow the protocol.
