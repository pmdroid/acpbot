---
id: "003"
title: Pin down ACP permission and question semantics
type: research
status: closed
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

## Resolution

**Asset:** `research/acp-semantics.md` on branch `research/acp-semantics`
(~1000 lines, eight incremental commits). Answered against ACP v1 (current
stable) on 2026-07-30 from the spec, the published JSON schema, and both Zed
adapter sources.

**Freshness caveat.** `elicitation/create` stabilized **2026-07-24 — six days
before this research**, and the Claude adapter's HEAD is dated the same day the
research ran. Section 5 (agent divergence) must be re-verified before anyone
implements against it. Specifically, check whether Codex has since gained an
elicitation path: `claude-agent-acp` anticipates one via a deliberately
un-namespaced `_askUserQuestionCustomAnswer` marker that no Codex bridge yet uses.

**Permission requests and questions are two different protocol mechanisms, and
ACP's authors refused to merge them on purpose.**

- `session/request_permission` requires `sessionId`, `toolCall`, `options`. The
  option `kind` is an enumerated hint (4 values in v1); `optionId` and `name`
  are free-form and agent-chosen. The response carries an `optionId` and
  **nothing else** — there is no field for a rejection reason. Critically, the
  accompanying metadata (title, arguments, diff, paths) is **all optional**: the
  spec's own example sends a bare `toolCallId`, so tacp must correlate against
  the tool-call update stream rather than read the request alone.
- Questions **are** a protocol primitive: `elicitation/create`, form mode —
  stabilized 2026-07-24, six days before this research.

The catch is agent support, and it splits cleanly. Claude's adapter bridges its
built-in `AskUserQuestion` tool into ACP form elicitation, **but disables the
tool entirely unless the client advertises `clientCapabilities.elicitation.form`**.
Codex never sends an elicitation at all and auto-declines the ones it receives.
So tacp must build both the structured path and the unmarked-prose path, where a
clarifying question is indistinguishable from commentary — that fallback is
itself what the spec tells agents to do when the client lacks the capability.

Also established: a turn may block on a permission response **indefinitely** —
no deadline, timeout, or expiry exists anywhere in ACP, so any timeout is tacp's
own policy with only two protocol-legal ways to express it.

19 implementation-defined gaps are collected in §6 as G1–G19, each a decision
the spec must make rather than inherit. The load-bearing ones for the round-trip
ticket: **G2** (whether to advertise `elicitation.form` — the highest-leverage
decision, since it switches Claude's questions between structured and prose),
**G4** (timeout policy), **G5** (no channel for "no, do it this way instead"),
**G7** (permission metadata may be absent), and **G8** (`optionId` is opaque and
the option set is unbounded — never hardcode allow/deny).
