---
id: "009"
title: Decide how tacp obtains structured questions through acpx
type: grilling
status: closed
assignee: pascal (this session)
blocked_by: []
---

## Question

Surfaced by [Verify the client-side fs and terminal permission path per agent](007-fs-terminal-permission-path.md),
which corrected a finding this map had already built on.

"Get messages for permission **or questions to answer**" is half the original
brief. The map established that questions are a real ACP primitive
(`elicitation/create`) and treated the decision as *whether tacp should advertise
`clientCapabilities.elicitation.form`*. That framing is now wrong: **tacp cannot
advertise it, because acpx never does.** acpx neither declares the capability nor
registers an `elicitation/create` handler, and `AcpRuntimeOptions` exposes no seam
to add one — the same missing-seam shape as the unreachable `fs`/`terminal`
passthrough.

Consequences as things stand: Claude's `AskUserQuestion` tool is **disabled
outright**, and the Codex adapter acpx actually launches
(`@agentclientprotocol/codex-acp@1.1.7`, which *does* elicit, contrary to the
earlier finding) has its elicitation support unreachable. Both agents fall back to
asking in prose — unmarked, indistinguishable from a finished answer.

Decide how tacp gets structured questions, or decides it doesn't need them:

1. **Accept prose-only.** Build only the unmarked-prose path: the operator replies
   to a finished turn like any other prompt. Costs nothing upstream, works today,
   and is the spec's own prescribed fallback. But it means Claude runs with a tool
   *disabled*, which may change how it behaves rather than merely how it asks —
   worth establishing before accepting this.
2. **Upstream a patch to acpx.** Add capability declaration plus a host hook,
   shaped like the existing `onPermissionRequest`. Cleanest long-term, and the
   same seam would fix `fs`/`terminal` and `confirmWrite` at once. Depends on
   acpx's willingness and release cadence — it is alpha and moving.
3. **Fork or patch locally.** Fastest control, and the substrate decision already
   accepted alpha-API risk. Cost: carrying a patch across an alpha library's
   releases.
4. **Reopen the substrate decision.** If the missing seams keep multiplying,
   embedding acpx may be the wrong call and speaking ACP directly may be cheaper
   than patching around it. This is the map-altering option and should be argued
   explicitly rather than drifted into.

Establish first, since it changes the weight of option 1: **does disabling
`AskUserQuestion` degrade Claude's behaviour, or only its phrasing?** If the model
merely asks in prose instead, prose-only is a cheap and honest answer. If it
instead stops asking and guesses, that is a correctness problem and options 2–4
become necessary rather than nice.

The answer determines what
[Design the permission and question round-trip](005-permission-question-round-trip.md)
is designing, so it blocks it.

Use `/grilling`. Where the decision turns on a fact about acpx's or the adapters'
behaviour, look it up rather than reasoning about it — the last two corrections on
this map both came from reading shipped artifacts instead of repositories.

## Resolution

**Fork acpx and add the elicitation seam in source. Do not open an upstream issue
or PR yet.**

**Why not upstream first.** Deferred, not dropped. Arguing for a seam you have
proven in use beats arguing for one you have only designed — and the shape of the
right hook is exactly what building against it will teach. Revisit once tacp has
something working; the fork is a strictly better starting position for that
conversation than a design sketch.

**Fork mechanics: a git fork of source, built, depended on by ref.** Patch the
TypeScript source rather than the published `dist`, so tracking upstream is a real
merge with real conflict markers instead of a patch that anchors to compiled
output and rejects on the next release. acpx ships roughly weekly, so this will be
re-applied often and the failure mode matters more than the setup cost.
`patch-package` was rejected for exactly that reason; vendoring was rejected
because it discards the upstream link that motivated embedding acpx at all.

**What the patch adds**, mirroring the existing `onPermissionRequest` precisely —
that hook is already proven to be awaited unbounded, which is the same property an
elicitation round-trip needs:

1. Declare `clientCapabilities.elicitation.form` during `initialize`.
2. Register an `elicitation/create` handler.
3. Expose a host hook on `AcpRuntimeOptions` that the handler delegates to.

**Scope discipline: patch elicitation only.** The instinct to fix `fs`/`terminal`
and `confirmWrite` in the same seam should be resisted —
[ticket 007](007-fs-terminal-permission-path.md) established both are unreachable
for the agents acpx actually launches, so patching them adds fork surface to carry
for no behavioural gain. They become worth revisiting only when a third agent is
added.

**The prose path is still mandatory and is not contingent on this.** Any agent
without elicitation falls back to unmarked prose, and that is the spec's
prescribed behaviour, so the round-trip must handle it regardless. This decision
determines whether tacp *also* gets structured questions — it does not remove any
prose work.

### Correcting the framing that produced this ticket

The ticket was written arguing that three missing seams in the same shape made
reopening the substrate decision live. **On the facts, that was overstated.** Two
of the three are inert: the `fs`/`terminal` path is never exercised by either
agent, and `confirmWrite` is consequently a non-issue. Only elicitation actually
bites. One real gap in an actively-maintained MIT library — 37 releases since
February 2026, the latest three days before this decision — is not a pattern of
decay, and **the substrate decision stands unreopened.**

**Also unresolvable from source, and left open honestly:** whether disabling
`AskUserQuestion` makes Claude *ask less* or merely *ask in prose*. The tool is a
presentation channel and prose is its designed fallback, but whether its absence
nudges the model toward guessing at decision points is behavioural and cannot be
read out of the adapter. The fork makes this moot for Claude by restoring the
tool; it remains a live question for any agent tacp does not patch around.

**Confirmed unclaimed upstream:** no open acpx issue and no commits mention
elicitation, so the fork collides with nothing in flight.
