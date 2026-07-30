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

- [Probe acpx/runtime for async permission interception](tickets/001-acpx-runtime-permission-probe.md)
  — **Yes**: `onPermissionRequest` is awaited unbounded and wins over static
  policy, so a chat round-trip can hold a permission open indefinitely. Substrate
  decision stands. Imposes three build constraints (never set `timeoutMs`;
  client-side `fs`/`terminal` gates bypass the hook; tacp owns durability,
  listing and queueing). Findings: branch `research/acpx-runtime`.
- [Survey the Telegram Bot API for the control surface](tickets/002-telegram-bot-api-survey.md)
  — Topics-per-session is **viable**, and Bot API 9.3/9.4 added topics to the
  bot's *private* chat, adding a fourth candidate that skips supergroups
  entirely. Inline keyboards survive a restart (24 h update retention, decision
  recoverable from `callback_data` alone) but `answerCallbackQuery` does **not** —
  confirm by editing the message, never by answering the callback. Binding design
  constraint: `callback_data` is 64 **bytes**, so prompts need opaque tokens.
  Findings: branch `research/telegram-bot-api`.
- [Pin down ACP permission and question semantics](tickets/003-acp-permission-question-semantics.md)
  — Permissions and questions are **two separate mechanisms** and ACP's authors
  refused to merge them on purpose. Questions *are* a primitive
  (`elicitation/create`, stabilized six days ago), but **Claude disables its
  question tool entirely unless tacp advertises `clientCapabilities.elicitation.form`**,
  and **Codex never elicits at all** — so the unmarked-prose path must be built
  too. A turn can block on permission **indefinitely**; any timeout is tacp's own
  invention. Collects 19 implementation-defined gaps (G1–G19) the spec must
  decide rather than inherit. Findings: branch `research/acp-semantics`.
- [Choose the session-to-Telegram surface model](tickets/004-session-surface-model.md)
  — **One topic per session (`repo/name`) in the bot's private chat.** Switching
  is navigation — tap a topic, no `/switch`, no current-session pointer. Topic
  name carries live state, so the list is the dashboard. Retire by rename, never
  auto-delete. Root area is a commands-only lobby. Makes wrong-session approval
  structurally near-impossible. Mock:
  [`assets/004-surface-model-mock.md`](assets/004-surface-model-mock.md).

## Not yet specified

In scope, but not yet sharp enough to ticket. Graduates as the frontier advances.

- **What tacp itself must persist.** Sharpened but not yet ticketable: the probe
  established that `AcpSessionStore` is an injectable `load`/`save` interface with
  **no `list()`**, that a handle is fully reconstructible from one string via
  `encodeAcpxRuntimeHandleState`, and that `acpxRecordId === sessionKey` for
  persistent sessions — so a chat or topic id can be the primary key. What remains
  open is the rest of tacp's own state: chat/topic ↔ session bindings, the session
  list acpx does not provide, and pending permission requests that must survive a
  restart. Both surveys converged on the same point from opposite ends — acpx's
  session store has no `list()` and Telegram has no way to enumerate topics — so
  **tacp must own the mapping durably; neither side can reconstruct it.** Also
  needs to hold the opaque tokens that `callback_data`'s 64-byte cap forces. The
  surface model has since fixed one half of it — the mapping is
  `message_thread_id` → session, and owning it durably is now a hard requirement
  rather than a preference. What still waits on the round-trip is the shape of a
  *pending permission* record: what must be recoverable after a restart, and how a
  64-byte callback token dereferences to it.
- **Failure behaviour as the operator experiences it.** Agent process dies
  mid-turn; tacp restarts holding an unanswered permission prompt; Telegram is
  unreachable for ten minutes. What the operator sees, and what is recoverable.
  Waits on the round-trip design.
- **The portability contract.** Exactly which things become configuration to honour
  "local now, server later" — repo roots, agent credential resolution, process
  supervision. Sharpens once session lifecycle is decided.
- **Agent adapter scope.** Which agents beyond `codex` and `claude` the spec
  commits to, and how their auth resolves off the Mac. The probe narrowed the
  portability half: the runtime needs no TTY and takes an explicit `cwd`, so the
  only real pin is that agents spawn as local child processes relying on their own
  on-disk login state. Per-agent *permission* behaviour graduated out of this patch
  into its own ticket; what stays here is the scope question.
- **Spec assembly.** How the final document is structured and handed off. Only
  specifiable once the decisions it collects exist.

## Out of scope

Ruled beyond this destination. Never graduates; returns only as a fresh effort.

- **Output volume policy** — what streams live vs. collapses into a digest, message
  chunking against Telegram's message cap, and rate-limit backpressure. Ruled out
  by the operator during charting and affirmed afterwards; settled, not deferred.
  Sessions should record the Telegram limits they encounter as facts, and must not
  design around them. If the surface model genuinely cannot be decided without a
  volume policy, that is a new effort — not a reason to pull this back in.
- **Multi-tenancy** — accounts, workspace isolation, per-user credentials, quotas.
  Excluded by the single-operator decision.
- **Flows** — `acpx flow`-style multi-step orchestration over several turns. The
  destination is interactive session control, not authored workflows.
- **Non-Telegram clients** — the surface is Telegram specifically.
- **The implementation** — this effort ends at a spec.
