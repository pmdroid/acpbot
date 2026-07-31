# acpx fork for tacp

Based on [openclaw/acpx](https://github.com/openclaw/acpx) **v0.13.0** (MIT).

## Patch

Branch: `tacp/elicitation-seam`

1. Advertise `clientCapabilities.elicitation.form` during initialize
2. Register `unstable_createElicitation` → `handleElicitationRequest`
3. Host hook `onElicitationRequest` on `AcpClientOptions` / `AcpRuntimeOptions`
   (unbounded await, same contract as `onPermissionRequest`)

Elicitation only — no `fs` / `terminal` / `confirmWrite` changes.

## Upstream tracking

Merge of `origin/main` was exercised after the patch commit (clean ort merge;
only `CHANGELOG.md` from upstream 0.13.1 development).

To re-attach a full remote fork:

```bash
cd forks/acpx
git init
git remote add upstream https://github.com/openclaw/acpx.git
git fetch upstream
# cherry-pick or re-apply the elicitation commits from tacp history
```

Build: `bun install && bun run build`
