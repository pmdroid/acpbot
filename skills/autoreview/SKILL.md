---
name: autoreview
description: >
  Native two-agent closeout review (panel or adversarial) via /review or
  review_run MCP. Use for second-opinion / pre-PR / after non-trivial edits.
  Advisory only — never auto-apply findings.
---

# Auto Review

Run a **frozen-bundle dual review** using two ACP agents on PATH (e.g. Codex + Claude). acpbot freezes the change bundle, spawns temporary reviewer slots, validates structured JSON, and merges results.

## When to use

- Operator asks for autoreview / second opinion / pre-PR check
- After non-trivial code edits, before commit/ship
- Prefer **before** push/PR when the work is already in the session cwd

Skip for prose-only docs / skill text unless the operator insists.

## Surfaces

| Who | How |
|---|---|
| Operator | `/review [local\|branch] [agentA] [agentB] [panel\|adversarial]` |
| Agent | MCP `review_run({ mode, protocol, agent_a, agent_b, … })` |

Defaults:

- **mode** `local` (dirty tree); `branch` vs `origin/main` (or merge-base)
- **protocol** `panel` — independent dual review, then agreement merge
- **protocol** `adversarial` — A finds, B accepts/rejects each finding
- **max priority** `P0` (blockers only)
- Reviewers auto-pick `codex`+`claude` when both installed

## Contract

- Treat output as **advisory**. Verify every accepted finding in real code.
- Do **not** blind-apply fixes from the report.
- Do **not** invent a second dual-spawn review loop when `review_run` exists.
- Do **not** nest reviewers inside a review (no review-of-review loops).
- Prefer small fixes at the right ownership boundary.
- If you fix accepted findings, re-run focused tests and optionally `/review` again.

## Protocols

### panel (default)

Both reviewers see the **same frozen diff**, no cross-talk. Host merges:

- **AGREED** — same file:line + title from both
- **UNIQUE** — one reviewer only

### adversarial

1. Reviewer A (finder) → structured findings  
2. Reviewer B (challenger) → accept/reject each finding  
3. Digest shows accepted set + rejected with reasons  

## Examples

Operator:

```text
/review
/review branch codex claude
/review local codex claude adversarial
```

Agent (MCP `acpbot`):

```text
review_run({ mode: "local", protocol: "panel", agent_a: "codex", agent_b: "claude" })
review_run({ mode: "branch", protocol: "adversarial", agent_a: "codex", agent_b: "claude" })
```

## Artifacts

Written under `$state_dir/reviews/<id>/`:

- `bundle.diff` — frozen patch
- `files.txt` — changed paths
- `result.json` / `result.md` — merged report

## Final report (to operator)

Include:

- command / tool used + reviewers + protocol
- agreed vs unique counts (or accepted vs rejected for adversarial)
- which findings you accept/reject and why
- tests/proof run if you fixed anything

Do not re-run review solely to polish wording after a clean result.
