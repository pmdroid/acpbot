---
id: "009"
title: Decide how tacp obtains structured questions through acpx
type: grilling
status: open
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
