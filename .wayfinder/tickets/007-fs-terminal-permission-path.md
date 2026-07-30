---
id: "007"
title: Verify the client-side fs and terminal permission path per agent
type: research
status: open
assignee: null
blocked_by: ["003"]
---

## Question

Surfaced by [Probe acpx/runtime for async permission interception](001-acpx-runtime-permission-probe.md),
which found a trap worth closing before anyone builds on it.

acpx's `FileSystemHandlers` is constructed without a `confirmWrite`, so
`fs/write_text_file` and the `terminal/*` methods are gated by the static
`permissionMode` alone — they never reach `onPermissionRequest`, and therefore
never reach Telegram. With no TTY the fallback y/N prompt returns `false`, so
under `permissionMode: "approve-reads"` **writes silently deny**. A tacp daemon
has no TTY by definition.

The probe recommended `permissionMode: "approve-all"` on the reasoning that
mainstream adapters do their own IO and surface real tool calls through
`session/request_permission`, leaving the host hook in control. That reasoning is
sound but unverified, and `approve-all` is exactly the setting where being wrong
is worst.

Establish, per agent (`codex` and `claude` at minimum):

1. **Is the client-side path actually exercised?** Do these agents call
   `fs/write_text_file` and `terminal/*` back into the client, or do they perform
   their own IO in-process and surface it as tool calls? Determine this from
   adapter source or an observed session, not from reasoning about what is likely.
2. **If exercised, what escapes the operator's control under `approve-all`?**
   Enumerate concretely what an agent could do without a Telegram prompt ever
   being sent.
3. **Is there a supported way to route these through the host hook?** Can a
   `confirmWrite` be injected by an embedder, or is this a gap that needs an
   upstream change or a fork?
4. **What is the safe `permissionMode` for a headless embedder** given the answers
   — and what does tacp lose by choosing it?

The output is a recommended `permissionMode` with the evidence behind it, plus an
explicit statement of what remains ungated. If the honest answer is "an agent can
write files without the operator seeing a prompt", that must be stated plainly —
the permission round-trip design depends on knowing where the real boundary is.

Blocked on the ACP semantics ticket, which establishes where Codex and Claude
diverge in what they implement.
