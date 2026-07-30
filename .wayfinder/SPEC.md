# tacp — a Telegram control surface for ACP coding agents

<!-- triage: ready-for-agent -->
<!-- status: PARTIAL — see "Open decisions" before implementing -->

> **Read this first.** This spec is written from a wayfinder map that is not yet
> complete. Four areas are decided and buildable; three are open tickets, and the
> largest of them — the permission round-trip — is the feature that most
> distinguishes tacp from the CLI it replaces. Sections that rest on an open
> decision are marked **OPEN** and name the ticket. Do not invent answers for
> them; resolve the ticket first.
>
> Map: [`.wayfinder/map.md`](map.md).

## Problem Statement

I drive coding agents — Codex, Claude — through `acpx`, a CLI that gives every ACP
agent one surface with persistent per-repo sessions. It works, and it keeps me at
a terminal.

An agent turn is mostly waiting. It reads, edits, runs tests, and then stops to
ask *"may I write this file?"* or *"which of these two approaches do you want?"*
Those moments are seconds of my attention and minutes of its idleness — but they
only reach me if I am sitting in front of the terminal that spawned the agent. If
I walk away, the work stops at the first question and stays stopped. If I have two
agents running, I cannot watch both.

I want the waiting to happen without me, and the questions to find me wherever I
am. A terminal cannot do that. A phone can.

The specific failures today:

- Work stalls silently the moment an agent needs an answer, and I don't find out
  until I come back.
- To avoid stalling I over-grant permissions up front (`--approve-all`), which
  trades safety for not being interrupted — exactly the wrong trade.
- Running several sessions means several terminals, and no way to see at a glance
  which one needs me.
- Nothing survives closing the laptop lid.

## Solution

A Telegram bot that is the control surface for my agents.

Each session is a **topic** in my private chat with the bot. The topic list is the
dashboard: I glance at it and see which sessions are running, which are idle, and
which are blocked waiting on me. Switching sessions is tapping a topic — there is
no `/switch` command and no "current session" to remember, because the chat
surface itself carries that state.

When an agent needs permission, the prompt arrives as a Telegram message with
buttons, in that session's topic. I answer from wherever I am, minutes or hours
later, and the agent continues. When it wants to ask me something, it asks, and I
reply like I'd reply to a person.

The daemon runs on my Mac and talks to my real repos. It uses long-polling, so it
needs no public URL, no TLS, and no tunnel.

## User Stories

### Seeing and switching

1. As the operator, I want each session to appear as its own topic in my chat with
   the bot, so that Telegram's own navigation does my session switching for me.
2. As the operator, I want to switch sessions by tapping a topic, so that I never
   have to remember which session I am currently talking to.
3. As the operator, I want a session's topic name to be `repo/name`, so that a
   lock-screen notification identifies the session unambiguously without me
   opening anything.
4. As the operator, I want to run several sessions in the same repo, so that I can
   have a refactor and a bug fix in flight at once without them sharing a
   scrollback.
5. As the operator, I want the topic name to show whether a session is running,
   idle, waiting on me, done, or failed, so that the topic list tells me where my
   attention is needed without opening a single session.
6. As the operator, I want a session that is blocked on a permission to be visibly
   marked *before* the prompt message lands, so that my chat list is already
   correct when the notification arrives.
7. As the operator, I want finished sessions to sink down the list on their own,
   so that I don't have to curate it.
8. As the operator, I want anything I type inside a topic to go to that session,
   so that replying is never ambiguous.
9. As the operator, I want agent output never to appear outside a topic, so that
   no message is ever ambiguous about which session produced it.

### Permissions and questions — **OPEN**, see ticket 005

10. As the operator, I want an agent's permission request to reach me as a
    Telegram message with buttons, so that I can approve or reject from my phone.
11. As the operator, I want the prompt to show me what is actually being requested
    — the tool, the affected paths, the diff — so that I can decide safely rather
    than reflexively.
12. As the operator, I want to take an hour to answer without anything breaking,
    so that stepping away is safe.
13. As the operator, I want to know what happens if I never answer, so that I am
    not surprised by a turn that hung all weekend.
14. As the operator, I want to grant "allow this kind of thing for the rest of
    this session", so that a long task doesn't ask me the same question twenty
    times.
15. As the operator, I want to answer a clarifying question with real words, not
    just a button, so that I can say "no, do it this way instead".
16. As the operator, I want a prompt I already answered to look answered, so that
    I don't approve the same thing twice.
17. As the operator, I want a permission request that arrived while the daemon was
    down to still be answerable when it comes back, so that a restart doesn't lose
    my agent's turn.
18. As the operator, I want to be sure my approval landed on the session I thought
    it did, so that I never authorise a write to the wrong repo.

### Session lifecycle — **OPEN**, see ticket 006

19. As the operator, I want to start a new session from my phone, so that I can
    kick off work away from my desk.
20. As the operator, I want to choose which repo a session works in without typing
    a filesystem path, so that starting work on a phone is not painful.
21. As the operator, I want to choose which agent runs a session, so that I can
    pick the right tool for the task.
22. As the operator, I want to see which sessions exist and what each is doing, so
    that I can pick up where I left off.
23. As the operator, I want to cancel a running turn without destroying the
    session, so that I can stop a bad direction and redirect it.
24. As the operator, I want to end a session but keep its transcript, so that I
    can read back what the agent did.
25. As the operator, I want deleting a session's history to be deliberate and
    confirmed, so that I never destroy a transcript by reflex.
26. As the operator, I want my sessions to still be there after the daemon
    restarts, so that a crash or a reboot doesn't lose my work.

### Steering a live session

27. As the operator, I want to send a follow-up while a turn is still running, so
    that I can redirect an agent going the wrong way.
28. As the operator, I want to see that the agent is working rather than stuck, so
    that I know whether to wait.
29. As the operator, I want to know when a turn has finished, so that I know it is
    my move.

### Safety and trust

30. As the operator, I want the bot to ignore everyone but me, so that knowing the
    bot's name grants no access to my machine.
31. As the operator, I want to know exactly what an agent can do *without* asking
    me, so that I can judge how much to trust a running session. **OPEN, ticket 007.**
32. As the operator, I want the daemon to refuse to start if it is misconfigured
    rather than degrade silently, so that I never discover a missing capability
    halfway through a task.
33. As the operator, I want an agent crash to be visible in the session's topic,
    so that a dead session doesn't look like an idle one.

### Portability

34. As the operator, I want the daemon to run on my Mac against my real repos, so
    that the work lands where I already work.
35. As the operator, I want no part of the design to assume local paths, locally
    cached credentials, or a terminal, so that I can move it to an always-on
    server later without a rewrite.

## Implementation Decisions

### Substrate: embed `acpx/runtime`

tacp is a Telegram front-end over the `acpx/runtime` library, not a
reimplementation of ACP and not a wrapper around the `acpx` CLI. It inherits
acpx's agent adapters, session storage, and ACP wire handling. The alpha API risk
is accepted knowingly.

Verified against acpx 0.13.0 (ticket 001):

- **`onPermissionRequest` is the load-bearing hook.** Signature
  `(req, ctx: { signal: AbortSignal }) => Promise<AcpPermissionDecision | undefined>`.
  It is awaited **unbounded** — no `Promise.race`, no timer, no deadline — so a
  handler that resolves after a chat round-trip resolves whenever the operator
  answers. It is consulted *before* the static `permissionMode` resolver and wins;
  returning `undefined` abstains to policy and a thrown error is caught and also
  falls through.
- **Decisions are** `allow_once | allow_always | reject_once | reject_always | cancel`.
  `req.raw` carries the unmodified ACP `RequestPermissionRequest`, including the
  agent's own offered options.
- **`timeoutMs` must never be set.** `runPromptTurn` wraps the entire
  `session/prompt` in a timeout that includes the permission wait. There is no
  default and omission disarms it, but any finite value would kill a turn the
  operator merely took their time over. Human deadlines belong in tacp's own
  handler.
- **A pending permission blocks nothing but its own turn.** The ACP SDK's read
  loop dispatches without awaiting, and each session is a separate child process
  with its own connection.
- **tacp owns durability, listing, and queueing.** `turn.events` is a
  single-consumer, non-resumable, unbounded queue that must be drained by a
  long-lived task and never gated on a chat round-trip. `AcpSessionStore` is a
  `load`/`save` interface with **no `list()`**. Prompt queueing exists only in the
  CLI layer; the runtime's answer to mid-turn input is `mode: "steer"`.

### Protocol: permissions and questions are two mechanisms

Verified against ACP v1 (ticket 003). ACP's authors considered folding permissions
into the question primitive and refused, on the grounds that permissions are
security decisions and conflating them would blur the boundary. tacp keeps them
separate.

- **Permissions** are `session/request_permission`. Only `toolCallId` is required
  — title, arguments, diff, and paths are all optional, and the spec's own example
  sends the bare id. **ACP has no tool-name field at all**; Claude smuggles one
  through `_meta`, Codex sends none. Rendering "which tool, which paths" therefore
  requires correlating against the tool-call update stream, so tacp maintains a
  `toolCallId → merged ToolCall` projection from that stream.
- **`optionId` is opaque and the option set is unbounded.** Never hardcode
  allow/deny; render whatever options the agent offered.
- **Questions** are `elicitation/create` (form mode), which stabilized 2026-07-24.
  Agent support splits sharply: **Claude disables its question tool outright
  unless the client advertises `clientCapabilities.elicitation.form`**, and
  **Codex never elicits at all**. Both the structured path and the unmarked-prose
  path must exist.
- **The prose path is unmarked.** A clarifying question asked in turn text arrives
  as `agent_message_chunk` then `stopReason: "end_turn"` — byte-identical to a
  finished answer. This is the spec's *prescribed* fallback, not an edge case.
- **Nothing will ever time a permission out.** No deadline, expiry, or timeout
  exists anywhere in ACP or acpx. A turn hangs indefinitely by default, and the
  only protocol-legal exits are picking a rejection option or cancelling the turn.
- **Two cancellation mechanisms** settle a pending permission differently
  (`cancelled` outcome vs. JSON-RPC `-32800`), and both appear in real adapter
  code.

### Surface: one topic per session in the bot's private chat

Decided in ticket 004; mock at [`assets/004-surface-model-mock.md`](assets/004-surface-model-mock.md).

| | |
|---|---|
| **Where** | Topics in the 1:1 chat with the bot. No supergroup, no admin rights, no privacy-mode trap, 1 msg/s rather than the group's 20/min. |
| **Topic =** | One ACP session, named `repo/name`. Several per repo is normal. |
| **Status** | Topic name rewritten via `editForumTopic` on transition: running / waiting-on-you / idle / done / failed. |
| **Retire** | Rename + icon swap. Never auto-delete. |
| **Delete** | Separate, explicitly confirmed command — `deleteForumTopic` destroys every message in the topic. |
| **Root area** | Commands-only lobby. Agent output never appears there. |

Consequences:

- **The status projection is a state machine over ACP events**, not a field.
  Transitions are driven by turn start, tool-call updates, permission raised,
  permission settled, turn end, and process death.
- **A permission raised must update the topic name before sending the prompt
  message**, so the chat list is correct when the push notification arrives.
- **Startup asserts `getMe.has_topics_enabled`** and exits otherwise. Topic mode
  in private chats is enabled through @BotFather, not the API, so the daemon
  cannot provision it and must not degrade silently.
- **Root-area handling is commands-only**, structurally preventing agent output
  from being emitted without a `message_thread_id`.

### Telegram constraints that bind the design

From ticket 002. Recorded as design inputs, not volume policy (see Out of Scope).

- **`callback_data` is capped at 64 bytes.** It cannot hold a file path, so every
  permission prompt carries an **opaque token** that dereferences to a pending
  request in tacp's own store.
- **Inline keyboards survive a restart; `answerCallbackQuery` does not.** The
  keyboard is server-side state and stays pressable through process death; a press
  while down queues for 24 h and arrives with `callback_data` intact, so the
  decision is recoverable with zero in-memory state. But the callback
  acknowledgement window is short and undocumented — community sources contradict
  each other across three orders of magnitude. **Treat `answerCallbackQuery` as
  always failing after a restart; deliver confirmation by editing the message.**
- **`reply_to_message` is dependable but not forceable.** Server-provided and
  unspoofable, but only populated when the operator uses the reply gesture.
  Free-text answers need a fallback chain: reply id → the sole pending question in
  this topic → a disambiguating keyboard.
- **Updates are at-least-once with offset-as-ack, and drop after 24 h.** Handlers
  must be idempotent. A sleeping Mac loses anything older than 24 h with no error
  and no gap indicator.
- **`getUpdates` is single-consumer** and returns 409 on conflict, which matters
  when a launchd restart overlaps a dying predecessor.

### Persistence: tacp owns the mapping

Two independent findings converge: Telegram cannot enumerate topics, and
`AcpSessionStore` has no `list()`. **Neither side can rebuild the session list**,
so tacp owns a durable store of its own holding at minimum:

- `message_thread_id` → session identity (`repo/name`), bidirectional.
- The session list itself, since acpx cannot enumerate.
- Opaque callback tokens → pending permission requests, surviving restart.
- Enough per-session state to restore the status projection.

`AcpSessionStore` is injectable over a JSON-serializable record, and
`encodeAcpxRuntimeHandleState` / `decodeAcpxRuntimeHandleState` make a session
handle reconstructible from a single string — so tacp's store can be the single
source of truth with no local-filesystem dependency. For persistent sessions
`acpxRecordId === sessionKey`, so a thread id can serve as the session key.

**OPEN (ticket 005):** the record shape for a *pending permission* — what must be
recoverable after a restart, and how the 64-byte token dereferences to it.

### Operator model

Single operator. One allowlisted Telegram user id; every other sender is ignored.
No accounts, no session ownership, no tenancy anywhere in the design.

### Host and portability

A local daemon on the operator's Mac using long-polling — no public URL, TLS, or
tunnel. But **local-first, portable later**: nothing may assume local filesystem
paths, locally cached agent credentials, or a live TTY. Where repos live is
configuration.

The runtime cooperates: no TTY required, `cwd` explicit per session, session store
injectable. The one genuine pin on moving to a server is that agents spawn as
local child processes relying on their own on-disk login state.

### Architecture: a pure core behind one edge port

The daemon core — update routing, session registry, permission broker, status
projection, persistence — is pure and depends on a single injected `Environment`
port at the process boundary, carrying:

- **telegram** — send, edit message, edit topic, create topic, answer callback, and
  an update source.
- **agents** — session creation over `acpx/runtime`, yielding an ACP event stream
  and raising permission requests.
- **clock** — current time and scheduled wakeups. Injected rather than ambient
  because the round-trip's unanswered-case policy is otherwise untestable.
- **store** — the durable mapping described above.

Nothing inside the core is mocked in tests. See Testing Decisions.

### Open decisions

Do not implement these from inference. Each is a live ticket.

| Area | Ticket |
|---|---|
| Permission prompt presentation, answer vocabulary, the unanswered case, restart-mid-flight recovery, whether to advertise `elicitation.form`, prose-question handling | [005](tickets/005-permission-question-round-trip.md) |
| Repo selection from a phone, agent selection, session creation, listing, cancel-vs-end-vs-delete, restart survival, concurrency cap | [006](tickets/006-repo-selection-session-lifecycle.md) |
| What an agent can do with no prompt: whether `fs`/`terminal` client methods are exercised per agent, the safe `permissionMode`, whether withholding client capabilities is a viable lever | [007](tickets/007-fs-terminal-permission-path.md) |
| Bot provisioning, and the measured `answerCallbackQuery` window | [008](tickets/008-provision-bot-topic-mode.md) |

## Testing Decisions

**No prior art exists** — the repository is greenfield. These decisions establish
it.

### What makes a good test here

A good test drives the daemon the way Telegram and an agent drive it, and asserts
on what the operator would see. It names no internal module. Concretely: push an
update into the fake environment, let the real core run, and assert on the
outbound Telegram calls — message text, keyboard contents, topic name after a
transition. A test that asserts a particular function was called, or reaches into
the session registry, is testing the implementation and should be rewritten.

### The seam

**One seam: the composite `Environment` port.** Tests instantiate the real daemon
core over a fake environment supplying telegram, agents, clock, and store.
Everything between the two edges is real. There are no internal seams and none
should be added; if something is hard to test, the fix is to drive it from the
edge, not to open a new hole.

The fake environment provides:

- a **telegram double** recording outbound calls and injecting inbound updates,
  including callback queries and replies;
- an **agent double** emitting scripted ACP event streams and raising permission
  requests on command, so a permission can be left pending indefinitely;
- a **controllable clock**, so an hour of operator silence is one call;
- an **in-memory store**, so restart is modelled by constructing a new core over
  the same store.

### What gets tested

- **Routing** — a message in a topic reaches that session; a message in root is
  treated as a command; agent output never lands outside a topic.
- **Status projection** — each ACP event sequence produces the right topic name,
  and a raised permission renames the topic *before* the prompt is sent.
- **Permission round-trip** — prompt rendered from a request carrying only a
  `toolCallId`; the opaque token round-trips within 64 bytes; a decision settles
  the pending request; an already-answered prompt cannot be answered twice.
- **Restart** — a new core over the same store recovers pending permissions and
  the thread mapping; a queued callback press is honoured; confirmation is
  delivered by message edit, never by `answerCallbackQuery`.
- **Idempotency** — a redelivered update produces no duplicate effect.
- **Unanswered permission** — advance the clock and assert the policy holds, and
  that the turn was never killed by a `timeoutMs` that should not exist.
- **Auth** — an update from any id but the operator's produces no outbound call at
  all.
- **Startup assertion** — `has_topics_enabled: false` exits rather than degrading.

### Contract tests against the real thing

The fakes encode beliefs about acpx and Telegram that could drift, and acpx is
alpha. A small, separately-run suite exercises the real `acpx/runtime` against a
stub ACP agent to confirm `onPermissionRequest` is still awaited unbounded and
still wins over `permissionMode`. This suite is expected to break on acpx
upgrades; that is its purpose.

## Out of Scope

- **Output volume policy** — what streams live versus collapses into a digest,
  chunking against the 4096-char cap, and rate-limit backpressure. Ruled out by
  the operator during charting and affirmed since. Telegram's limits are recorded
  as facts throughout; no policy is derived from them. If the implementation
  cannot proceed without one, that is a new effort, not a reason to pull it in.
- **Multi-tenancy** — accounts, workspace isolation, per-user credentials, quotas.
  Excluded by the single-operator decision.
- **Flows** — `acpx flow`-style multi-step orchestration. tacp is interactive
  session control, not authored workflows.
- **Non-Telegram clients.**
- **Reimplementing ACP.** tacp embeds `acpx/runtime`; if the runtime cannot do
  something, the answer is an upstream change or a recorded limitation.

## Further Notes

**This spec is partial by construction.** Roughly half the substantive design is
decided; the permission round-trip — the feature that most distinguishes tacp from
the CLI — is not. It is buildable up to the point where an agent first asks a
question.

**Two freshness risks, both recorded rather than mitigated.**

`elicitation/create` stabilized six days before the research that found it, and the
Claude adapter's HEAD was dated the same day. The agent-divergence findings must be
re-verified before implementing against them — in particular whether Codex has
since gained an elicitation path, which `claude-agent-acp` anticipates via a
deliberately un-namespaced `_askUserQuestionCustomAnswer` marker that no Codex
bridge yet uses.

Private-chat topics are about five months old — Bot API 9.3 (Dec 2025), with
bot-created topics only in 9.4 (Feb 2026) — against three years for supergroup
topics. **Supergroup topics remain the conservative fallback**, and every other
surface decision ports to them unchanged: granularity, status signalling,
retirement, and lobby semantics are all independent of which was chosen. The
supergroup route regains `closeForumTopic`/`reopenForumTopic` as a real archive
signal, at the cost of privacy-mode handling and the 20 msg/min cap.

**The safety boundary is not yet known.** Ticket 007 is verifying what an agent can
do under `approve-all` without any prompt reaching the operator — specifically
whether the client-side `fs`/`terminal` path, which bypasses `onPermissionRequest`
entirely, is exercised in practice. Until it reports, treat the blast radius of a
running session as unestablished. A promising lever under investigation: simply not
advertising `fs.writeTextFile` or `terminal` in `clientCapabilities`, forcing
agents to do their own IO and surface it as gated tool calls.

**Research assets**, all on throwaway branches: `research/acpx-runtime` (710
lines), `research/telegram-bot-api` (641), `research/acp-semantics` (1022), and
`research/fs-terminal-gate` (in flight).
