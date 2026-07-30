# 03 — Live agent turns with status projection

**What to build:** The operator types a prompt in a session's topic and a real
agent runs it. The topic name tracks what the session is doing — running, idle,
done, failed — so the topic list works as a dashboard and the operator can tell,
without opening anything, which sessions are alive and which have died.

This is the first ticket where a real agent process exists. A session spawns
through `acpx/runtime` with an explicit `cwd`, and the turn's ACP event stream
drives a status state machine. An agent process dying shows as **failed**, never
as idle — a dead session that looks idle is the failure this ticket exists to
prevent.

**Turn boundaries only — no streamed content.** The topic shows that a turn
started, that it is working, and that it finished. It does not yet echo the
agent's text, tool calls, or diffs. That requires an output volume policy, which
is out of scope for the current map, and this ticket is deliberately scoped to
defer it. Do not improvise one.

Two runtime constraints are load-bearing and must be enforced, not merely
observed:

- **`timeoutMs` is never set.** `runPromptTurn` wraps the entire `session/prompt`
  in a timeout that includes any permission wait. There is no default and omission
  disarms it, but any finite value would kill a turn the operator merely took
  their time over.
- **The turn event queue is drained by a long-lived task.** It is single-consumer,
  non-resumable and unbounded; it must never be gated on anything slow, and
  certainly never on a chat round-trip.

Includes a small contract suite, run separately from the main tests, exercising
the real `acpx/runtime` against a stub ACP agent. It asserts that
`onPermissionRequest` is still awaited unbounded and still wins over
`permissionMode`. acpx is alpha; this suite is expected to break on upgrades, and
that is its purpose — the fakes elsewhere encode these beliefs and would otherwise
drift silently.

**Blocked by:** 02 — Sessions become topics, and survive restart.

**Status:** ready-for-agent

- [ ] A prompt typed in a topic spawns an ACP session with an explicit `cwd` and
      runs a turn
- [ ] The topic name transitions through running → idle → done across a turn
- [ ] An agent process dying renames the topic to failed and is visible without
      opening the session
- [ ] Status transitions are driven by ACP events through a state machine, tested
      by feeding scripted event sequences
- [ ] `timeoutMs` is never set on a turn — asserted by test, not by convention
- [ ] The event queue is drained by a long-lived task and never blocks on an
      outbound Telegram call
- [ ] Contract suite against real `acpx/runtime` confirms `onPermissionRequest` is
      awaited unbounded and beats `permissionMode`
- [ ] No agent text, tool call, or diff content is emitted to the topic
