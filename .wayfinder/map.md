# tacp — a Telegram control surface for ACP coding agents

<!-- label: wayfinder:map -->

## Destination

A build-ready spec for `tacp`: a Telegram bot that is the control surface for ACP
coding agents — switch between live sessions, steer them, and answer their
permission requests and questions from chat. Done when someone can open the spec
and start building without another round of design decisions.

This effort produces the spec, not the implementation.

## Notes

**Domain.** [acpx](https://acpx.sh/) is the reference point: one CLI over every ACP
coding agent (Codex, Claude, Gemini, Cursor, …), with persistent per-repo sessions,
a prompt queue, permission policy as a flag, and structured NDJSON event output.
tacp keeps that model but replaces the terminal with a Telegram chat — which
changes the hard part, because a terminal permission prompt blocks for seconds
while a chat prompt may go unanswered for hours.

**Locked before charting** (do not relitigate without redrawing the destination):

- **Substrate** — embed `acpx/runtime` as a library. Inherit its agent adapters,
  session storage, queue ownership, and ACP wire handling. The alpha API risk is
  accepted knowingly.
- **Host** — a local daemon on the operator's Mac using Telegram long-polling, so
  no public URL, TLS, or tunnel is needed. But *local-first, portable later*:
  **no ticket may assume local filesystem paths, locally-cached agent credentials,
  or a live TTY.** Where repos live is configuration, not an assumption.
- **Operators** — a single operator. One allowlisted Telegram user ID. No accounts,
  no tenancy, no session ownership, no "whose session is this".

**Skills every session should consult.** `/grilling` for decisions, `/prototype`
for the two surface/UX tickets (a rough mock beats an argument), `/research` for
AFK fact-finding.

**Standing preference.** Prototypes here are throwaway artifacts to react to, not
the beginning of the implementation. Plan, don't do.

## Decisions so far

<!-- one line per closed ticket: enough to judge relevance, then open the link -->

_None yet — the map was just charted._

## Not yet specified

In scope, but not yet sharp enough to ticket. Graduates as the frontier advances.

- **What tacp itself must persist.** `acpx/runtime` owns session state, but tacp
  has its own: chat/topic ↔ session bindings, and pending permission requests that
  must survive a bot restart. The shape of that store can't be specified until the
  surface model and the round-trip are settled.
- **Failure behaviour as the operator experiences it.** Agent process dies
  mid-turn; tacp restarts holding an unanswered permission prompt; Telegram is
  unreachable for ten minutes. What the operator sees, and what is recoverable.
  Waits on the round-trip design.
- **The portability contract.** Exactly which things become configuration to honour
  "local now, server later" — repo roots, agent credential resolution, process
  supervision. Sharpens once session lifecycle is decided.
- **Agent adapter scope.** Which agents beyond `codex` and `claude` the spec
  commits to, and how their auth resolves off the Mac. Waits on the acpx/runtime
  probe and the portability contract.
- **Spec assembly.** How the final document is structured and handed off. Only
  specifiable once the decisions it collects exist.

## Out of scope

Ruled beyond this destination. Never graduates; returns only as a fresh effort.

- **Output volume policy** — what streams live vs. collapses into a digest, message
  chunking against Telegram's 4096-char cap, and rate-limit backpressure.
  Consciously deferred by the operator during charting. Flagged risk: the surface
  model may back into this, in which case it returns as its own effort.
- **Multi-tenancy** — accounts, workspace isolation, per-user credentials, quotas.
  Excluded by the single-operator decision.
- **Flows** — `acpx flow`-style multi-step orchestration over several turns. The
  destination is interactive session control, not authored workflows.
- **Non-Telegram clients** — the surface is Telegram specifically.
- **The implementation** — this effort ends at a spec.
