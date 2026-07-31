# 04 — Fork acpx and add the elicitation seam

**What to build:** An agent can ask the operator a structured question, and tacp
can receive it. Today it cannot: acpx neither advertises
`clientCapabilities.elicitation` nor registers an `elicitation/create` handler,
which disables Claude's `AskUserQuestion` tool outright and makes the Codex
adapter's elicitation support unreachable. This ticket restores the channel.

Fork `openclaw/acpx` (MIT) and patch the **TypeScript source**, not the published
`dist`. Depend on the fork by git ref. acpx ships roughly weekly, so this patch
gets re-applied often — patching source means tracking upstream is a real merge
with real conflict markers, where patching build output means a diff that anchors
to compiled code and rejects on the next release.

Three changes, mirroring the existing `onPermissionRequest` precisely. That hook
is already proven to be awaited unbounded, which is exactly the property an
elicitation round-trip needs:

1. Declare `clientCapabilities.elicitation.form` during `initialize`.
2. Register an `elicitation/create` handler.
3. Expose a host hook on the runtime options that the handler delegates to.

**Patch elicitation only.** The instinct to fix `fs`/`terminal` and `confirmWrite`
through the same seam should be resisted — both are unreachable for the agents
acpx actually launches, so patching them adds fork surface to carry for no
behavioural gain. They become worth revisiting only when a third agent is added.

**This does not remove any prose work.** Any agent without elicitation falls back
to unmarked prose, and that is the protocol's prescribed behaviour, so the
round-trip must handle prose regardless. This ticket determines whether tacp
*also* gets structured questions.

**Do not open an upstream issue or PR yet.** That is deliberately deferred until a
working proof exists — a seam proven in use is a far stronger argument than one
only designed.

**Blocked by:** None — can start immediately. Independent of slices 01–03. If done
before slice 03, that slice should depend on the fork so the dependency shape is
right from the start rather than swapped later.

**Status:** ready-for-agent

- [ ] Fork exists, tracks upstream, and builds from source
- [ ] `clientCapabilities.elicitation.form` is advertised during `initialize`
- [ ] An `elicitation/create` handler is registered and delegates to a host hook
- [ ] The host hook is awaited without a deadline, matching `onPermissionRequest`
- [ ] tacp depends on the fork by git ref and builds against it
- [ ] Claude's `AskUserQuestion` is observably enabled — verified against a real
      agent, not inferred from the adapter's source
- [ ] No `fs`, `terminal`, or `confirmWrite` changes are included
- [ ] Merging current upstream into the fork is exercised once, to confirm the
      patch survives a real merge
