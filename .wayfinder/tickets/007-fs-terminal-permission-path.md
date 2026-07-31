---
id: "007"
title: Verify the client-side fs and terminal permission path per agent
type: research
status: closed
assignee: research-agent (fs-terminal-gate)
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

## Resolution

**Asset:** `research/fs-terminal-gate.md` on branch `research/fs-terminal-gate`
(810 lines, seven incremental commits). Zoom there for citations.

**The probe's reasoning was right, and its conclusion was still dangerously
incomplete.** Two findings that point opposite ways.

**1. The acpx gap is real but unreachable.** Neither `codex` nor `claude` calls
`fs/write_text_file`, `fs/read_text_file`, or any `terminal/*` method. Verified
against the artifacts acpx actually launches, not just repos: the shipped
`@agentclientprotocol/claude-agent-acp@0.60.0` makes exactly six agent→client
requests (`session/update`, `session/request_permission`, `fs/read_text_file`,
`fs/write_text_file`, `elicitation/create`, `elicitation/complete`) and the two
`fs` ones have **no internal caller** — they are pass-throughs with zero call
sites. Zero `terminal/*` references at all. `@agentclientprotocol/codex-acp@1.1.7`
issues exactly one client request, `session/request_permission`. Both spawn their
own CLI (`pathToClaudeCodeExecutable`; `spawn(codexPath, ["app-server"])`) and do
all IO in-process. So `permissionMode: "approve-all"` opens **no hole through
acpx** for these two agents, and `confirmWrite` is a non-issue today.

**2. But an agent can absolutely write files with no Telegram prompt — and by
default it will.** The gate that matters is not acpx's `permissionMode`; it is
**the agent's own session mode**, which each adapter picks for itself and which
acpx never sets. `@agentclientprotocol/codex-acp@1.1.7` ships
`DEFAULT_AGENT_MODE = AgentMode.Agent` — `approvalPolicy: "on-request"`,
`sandboxPolicy: {type: "workspaceWrite"}` — and passes it on every `runTurn`,
overriding `config.toml`. Under it Codex creates, edits and deletes files
anywhere under cwd and runs arbitrary sandboxed shell commands (`rm -rf`,
`git reset --hard`, `npm run …`) **with no `session/request_permission` at all**.
Claude has the same shape whenever `~/.claude/settings.json` sets
`permissions.defaultMode` to `acceptEdits`/`auto`/`bypassPermissions` or carries
`permissions.allow` rules. Reads are ungated in **every** configuration of both
agents, with full-disk read access.

**The fix is `setMode`, not `permissionMode`.** Recommended wiring:

```ts
permissionMode: "approve-all",
nonInteractivePermissions: "deny",           // never "fail"
onPermissionRequest: <Telegram round-trip>,  // NEVER resolve undefined
// then, immediately after ensureSession:
await runtime.setMode({ handle, mode: "read-only" /* codex */ | "default" /* claude */ });
```

Plus `INITIAL_AGENT_MODE=read-only` in the codex adapter's environment to close
the window before the first `setMode`. Mode ids differ between the Rust and TS
Codex adapters (`auto` vs `agent`) — read them from `getStatus`, never hardcode.

**What stays ungated even then:** all file reads and searches; agent-internal
context IO (CLAUDE.md/AGENTS.md, skills, git probing) which emits no tool call;
and **operator-configured hooks**, which run arbitrary shell commands and are
invisible to ACP entirely — a Claude `PreToolUse` hook returning
`permissionDecision: "allow"` resolves the check before `canUseTool` is reached.
tacp's permission round-trip is a control over what the model *chooses* to do,
not a sandbox; a hard guarantee needs a dedicated user/container.

**`confirmWrite` injection is impossible** — `AcpRuntimeOptions` has no
`fs`/`terminal`/`confirmWrite`; `AcpRuntimeManager` and `AcpClient` are not
exported from `acpx/runtime`; and `confirmWrite` has no plumbing even on
`AcpClientOptions`. Upstream change or fork, but **not urgent**, since the path
is unreachable.

**Withholding `clientCapabilities` is not the clean answer it looked like.**
Spec-blessed (agents `MUST NOT` call unadvertised methods) but a no-op here —
neither agent reads `clientCapabilities.fs`/`.terminal` — and `AcpRuntimeOptions`
cannot express it anyway (only the CLI's `--no-fs`/`--no-terminal` can). Worth an
upstream issue as a cheap invariant; becomes **required** the day a third agent
is added, since `TerminalManager` has no cwd restriction and `approve-all` would
auto-approve its `terminal/create` calls outright.

**Two corrections for tickets 003 and 005.** The Codex adapter acpx launches is
`@agentclientprotocol/codex-acp@1.1.7`, a **TypeScript rewrite over `codex
app-server`**, not the Rust `zed-industries/codex-acp` that 003 analysed — it
**does** send `elicitation/create` and its `optionId` vocabulary is entirely
different (003's "treat `optionId` as opaque" rule survives; its tables do not).
And **acpx never advertises `clientCapabilities.elicitation`** nor registers an
`elicitation/create` handler, so the capability 003 called *"the single most
important interop fact for tacp"* is currently switched off through acpx —
disabling Claude's `AskUserQuestion` and making the new Codex elicitation support
unreachable. Same missing seam as the `fs`/`terminal` passthrough.
