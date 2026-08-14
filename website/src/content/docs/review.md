---
title: Review
description: Dual-agent closeout review — /review, review_run MCP, panel and adversarial protocols.
order: 18
section: advanced
---

Closeout review runs **two ACP agents** against a **frozen git bundle**, then merges structured findings for the operator. Use it for second opinions, pre-PR checks, and after non-trivial edits.

Surfaces:

| Who | How |
|---|---|
| Operator | Telegram **`/review`** in a session topic |
| Agent | MCP **`review_run`** on host server `acpbot` |
| Skill | Bundled **`autoreview`** — [skills/autoreview](https://github.com/pmdroid/acpbot/blob/main/skills/autoreview/SKILL.md) |

Requires **two** agent CLIs on `PATH` (e.g. `codex` + `claude`). Defaults prefer that pair when installed.

## Operator: `/review`

```text
/review [local|branch] [agentA] [agentB] [panel|adversarial]
```

### Examples

```text
/review
/review branch codex claude
/review local codex claude adversarial
```

### Arguments

| Arg | Values | Default |
|---|---|---|
| Target mode | `local` · `branch` | `local` |
| Agent A | registry id (`codex`, `claude`, `cursor-agent`, `grok-build`, …) | auto (prefer codex) |
| Agent B | registry id (must differ from A) | auto (prefer claude) |
| Protocol | `panel` · `adversarial` | `panel` |

Max finding priority for the digest is **P0** (blockers only) unless you change that later via MCP `max_priority`.

Progress messages appear in the topic while the bundle freezes and each reviewer runs. The final digest is posted as Markdown (chunked if large).

## Target modes

| Mode | What is frozen |
|---|---|
| **local** | Dirty tree: staged + unstaged vs `HEAD`, plus untracked files (as added-file diffs) |
| **branch** | Merge-base of `HEAD` vs base (`origin/main`, then `origin/master` / `main` / `master`) through `HEAD` |

The session **cwd** must be a git work tree. Bundle size hard-fails above ~10 MB (warn above ~1 MB).

Empty bundles short-circuit: “nothing to review” (no agent turns).

## Protocols

### panel (default)

Both reviewers get the **same** frozen diff and schema. No cross-talk.

Host merge labels:

| Label | Meaning |
|---|---|
| **AGREED** | Same file:line + similar title from both reviewers |
| **UNIQUE** | Only one reviewer raised it |

Overall correctness lines from each reviewer are shown in the digest.

### adversarial

1. **Finder (A)** produces a structured finding list  
2. **Challenger (B)** accepts or rejects each finding (no new invent-unless-prompted issues)  
3. Digest shows the accepted set, plus a “rejected by challenger” section  

If the challenger fails to parse, findings fall back to the finder set (labeled uniquely).

## Finding shape

Reviewers return JSON (optional ` ```json ` fence):

| Field | Notes |
|---|---|
| `findings[]` | `title`, `body`, `priority` (`P0`–`P3`), `confidence` (0–1), `category`, `code_location.file_path` + `line` |
| `overall_correctness` | `patch is correct` \| `patch is incorrect` |
| `overall_explanation` | Short narrative |
| `overall_confidence` | 0–1 |

Categories: `bug`, `security`, `regression`, `test_gap`, `maintainability`.

Reports are advisory: verify accepted findings in real code before applying fixes. Do not nest another dual review inside a review leaf.

## MCP: `review_run`

Host MCP server **`acpbot`** (same as `agent_spawn`, `update`, …):

```text
review_run({
  mode: "local" | "branch",       // default local
  protocol: "panel" | "adversarial",
  agent_a: "codex",
  agent_b: "claude",
  base: "origin/main",            // branch mode only
  max_priority: "P0" | "P1" | "P2" | "P3"
})
```

Worker API: `POST /v1/review/run` with `sessionKey` and the same fields. Long timeout (dual agent turns). The worker also posts the digest into the Telegram topic when possible.

Prefer `review_run` over inventing dual `agent_spawn` review loops.

## Artifacts

Under `$state_dir/reviews/<id>/` (default `~/.local/share/acpbot/state/reviews/…`):

| File | Content |
|---|---|
| `bundle.diff` | Frozen unified diff |
| `files.txt` | Changed paths |
| `meta.json` | Mode, label, sizes, empty flag |
| `result.json` | Structured merge / challenge output |
| `result.md` | Operator-facing digest |

## Skill

After `acpbot skills install`, agents discover **`autoreview`** from global skill dirs. The skill teaches when to call `review_run` / `/review` and the advisory contract. See [Skills](/docs/skills).

## Related

- [Agents](/docs/agents) — registry ids for `agent_a` / `agent_b`  
- [Multi-agent](/docs/multi-agent) — worktree spawn (different tool surface)  
- [MCP](/docs/mcp) — host `acpbot` tools  
- [Commands](/docs/commands) — slash surface  
