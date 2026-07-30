---
id: "001"
title: Probe acpx/runtime for async permission interception
type: research
status: closed
assignee: research-agent (charting session)
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

## Resolution

**Asset:** `research/acpx-runtime.md` on branch `research/acpx-runtime` (710 lines,
four incremental commits). Zoom there for API signatures and citations.

**The critical question: YES.** Async permission interception is a first-class
feature of `acpx/runtime`, not a workaround. The substrate decision stands.

`AcpRuntimeOptions.onPermissionRequest?: (req, ctx: { signal: AbortSignal }) =>
Promise<AcpPermissionDecision | undefined>` is awaited **unbounded** — no
`Promise.race`, no timer, no deadline. A handler that resolves hours later
resolves hours later. The host hook is consulted *before* the static
`permissionMode` resolver and wins; `undefined` abstains to policy, and a thrown
error is caught and also falls through. Decisions are `allow_once | allow_always |
reject_once | reject_always | cancel`. `req.raw` carries the unmodified ACP
`RequestPermissionRequest` — full tool call plus the agent's offered options —
which is enough to render a real Telegram prompt.

**Read loop verified rather than assumed.** `@agentclientprotocol/sdk@1.3.0`
`dist/jsonrpc.js` `receive()` calls `receiveWireMessage(message)` without awaiting
and discards the promise. A pending permission therefore blocks neither its own
connection (updates keep streaming while the operator decides) nor any other
session — each session is its own child process with its own connection. Only the
agent's own turn waits, which is the correct semantics.

**Three constraints this imposes on the build:**

1. **Never set `timeoutMs`.** `runPromptTurn` wraps the whole `session/prompt` in
   `withTimeout(...)`, permission wait included — any finite value would kill a
   turn the operator sat on. There is no default and omission disarms it
   (`if (timeoutMs == null || timeoutMs <= 0) return await promise`), but it is a
   live footgun. Human deadlines belong inside tacp's own handler.
2. **Client-side `fs`/`terminal` gates bypass `onPermissionRequest` entirely.**
   `FileSystemHandlers` is built without a `confirmWrite`, so `fs/write_text_file`
   is gated by `permissionMode` alone and falls back to a TTY y/N prompt that
   returns `false` with no TTY. `"approve-reads"` is the trap: writes silently
   deny. Recommendation is `permissionMode: "approve-all"` — tool gating still
   routes to Telegram via the host hook — pending per-agent verification, which is
   now its own ticket.
3. **tacp owns durability, listing, and queueing.** `turn.events` is a
   single-consumer, non-resumable, unbounded `AsyncEventQueue` — it must be
   drained by a long-lived task and **never** gated on a chat round-trip.
   `AcpSessionStore` is a two-method `load`/`save` interface with **no `list()`**.
   Prompt queueing is CLI-only (verified by import graph); the runtime's answer to
   mid-turn input is `mode: "steer"`.

**Portability is better than assumed.** No TTY required, `cwd` is explicit per
session, and `sessionStore` is an injectable interface over a JSON-serializable
record — tacp can hold zero local-filesystem dependency for session state. The
real pin is that agents spawn as local child processes relying on their own
on-disk login state.

**Two facts the surface and lifecycle tickets can build on:** for persistent
sessions `acpxRecordId === sessionKey`, so a chat or topic id can serve as the
session primary key; and `encodeAcpxRuntimeHandleState` / `decodeAcpxRuntimeHandleState`
make a handle fully reconstructible from a single string after a bot restart.
