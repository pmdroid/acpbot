# Idea: Multi-agent spawn via MCP tools (parent-linked slots + worktrees)

**Status:** parked for later (2026-08-04)
**Branch:** `docs/multi-agent-spawn` (PR)
**Not implemented** — design only.

Related: [multi-host-http3.md](./multi-host-http3.md) (where agents run). This doc is **how many agents cooperate**, parent-linked slots, **always-new git worktree**, and A2A.

## Intent

A **parent** ACP agent spawns other ACP agents through **acpbot MCP tools**. acpbot **owns lifecycle**, **links every child slot to its parent slot**, runs **each child in a fresh git worktree** (never the parent’s cwd), and provides an **A2A bridge** so plan → multi-agent implement → review works without file clashes or the human juggling topics.

---

## Core invariants

1. **Parent link:** every child has immutable `parentSessionKey` (host slotKey of parent).  
2. **Worktree:** every spawned child has **`cwd` = a new `git worktree`** created at spawn time. Never share the parent working tree.  
3. **Surface:** MCP tools only in v1 (no CLI). Skill teaches tools only.

---

## Decision: tools **or** CLI — pick **tools only**

| Surface | Verdict |
|---|---|
| **MCP tools** | Only v1 agent API |
| **`acpbot agent …` CLI** | Out of scope v1 |
| **Skill** | Documents MCP tools (+ worktree semantics for agents) |

---

## Why always a new worktree

| Without worktrees | With worktrees |
|---|---|
| Parallel children stomp the same files | Isolated trees / branches |
| Parent mid-edit races with implementer | Parent stays on its cwd; children on branches |
| Hard to open PRs per child | Natural: one branch per child → PR |
| Review agent sees dirty mixed state | Review can target child branch / worktree |

Spawned agents are **implementation workers**, not co-editors of the parent dirty tree.

---

## Worktree model

### Create on `agent_spawn`

acpbot (worker, on the machine that owns the repo / host) runs roughly:

```bash
# from parent repo root (git common dir)
git worktree add -b "<branch>" "<worktreePath>" "<startPoint>"
```

| Parameter | Default (v1) |
|---|---|
| **startPoint** | Parent session’s current HEAD (or `HEAD` in parent cwd) — optional override `base_ref` later |
| **branch** | `acpbot/<parentSlug>--<childSlug>` e.g. `acpbot/plan--impl-auth` (sanitized) |
| **worktreePath** | Under a dedicated base, **not** inside `.git` |

**Path layout (recommended):**

```text
# Option A — sibling of repo (clear, git-friendly)
{repoRoot}/../.acpbot-worktrees/{repoKey}/{sessionKeySafe}/
# or under state (central, no pollution of parent parent-dir):
{state_dir}/worktrees/{repoKey}/{sessionKeySafe}/
```

**v1 pick:** `$state_dir/worktrees/{repoKey}/{childSessionKey-sanitized}/`  
- Owned by acpbot, easy cleanup  
- Works even if repo is not writable for siblings  
- Host spawn `cwd` = that absolute path  

Requires: parent `cwd` is a git work tree (`git rev-parse --is-inside-work-tree`). If not git → **fail spawn** with clear error (MVP: git-only for multi-agent).

### Child session cwd

```text
Operator /new work/plan
  cwd = /repos/work                    # primary worktree (operator)

agent_spawn name=impl
  sessionKey = work/plan--impl
  parentSessionKey = work/plan
  branch = acpbot/plan--impl
  cwd = $state_dir/worktrees/work/plan--impl   # NEW worktree
```

`PersistedSession.cwd` for the child **is the worktree path** (same field as today — host already spawns with `cwd`).

### Dispose on `agent_kill` / cascade

When `dispose: true` (default on kill after done, or explicit):

```bash
git worktree remove --force "<worktreePath>"   # from primary repo
git branch -D "<branch>"                       # optional; keep branch if merged/PR open
```

Config:

```toml
[agents.spawn]
remove_worktree_on_kill = true
delete_branch_on_kill = false   # safer default: keep branch for PR
```

### Registry fields (worktree)

```ts
type SpawnRecord = {
  runId: string;
  childSessionKey: string;
  parentSessionKey: string;   // required
  agent: string;
  role?: string;
  status: "starting" | "idle" | "running" | "waiting" | "done" | "failed" | "killed";
  /** Absolute path of child worktree (session cwd) */
  worktreePath: string;
  /** Branch created for this child */
  branch: string;
  /** startPoint used at create (sha or ref) */
  baseRef: string;
  depth: number;
  createdAt: number;
  updatedAt: number;
  lastResultSummary?: string;
};
```

`PersistedSession` also stores `parentSessionKey`, `spawnRunId`, and `cwd` (= worktreePath).

### Concurrency / git rules

- One worktree per branch (git constraint) → branch names unique per child sessionKey  
- Parallel spawns: unique slugs → unique branches → OK  
- Lock: serialize `git worktree add` per repo (mutex on repoKey) to avoid git index races  
- Dirty parent: **allowed** — children start from committed HEAD (or recorded sha), not parent uncommitted junk unless we add `include_uncommitted` later (non-goal v1)

### MCP / skills in worktree

- Child `.acpbot/mcp.json` is the worktree copy (same as branch content)  
- Host MCP `acpbot` still injected; `ACPBOT_REPO_ROOT` = worktree path  
- Schedules in child worktree are separate files — prefer schedules only on parent (skill guidance)

### Operator UX

- Spawn notice: “Spawned **impl** in worktree `…` branch `acpbot/plan--impl`”  
- Child topic `/status` shows **cwd** (worktree) + branch  
- Parent can `agent_send` “open PR from your branch” after impl done  

### A2A + worktrees

Unchanged messaging model; children edit **their** tree. Parent (or review child) integrates via git (merge/PR), not shared dirty files.

Review spawn pattern:

```text
agent_spawn name=review agent=claude
  # still new worktree — but base_ref can be impl branch (phase 2)
  # v1: start from same HEAD as parent; prompt says "review branch acpbot/plan--impl"
```

**Phase 2 enhancement:** `agent_spawn({ base_ref: "acpbot/plan--impl" })` or `worktree_of: "impl"` to check out sibling branch for review. **v1:** always `base_ref = parent HEAD`; prompt carries branch name to review.

---

## Storage model: parent-linked slots (unchanged + worktree)

### Invariant

> Every child: non-null `parentSessionKey` + non-null `worktreePath` + non-null `branch`.  
> No orphan children; no child sharing parent cwd.

### Naming

- Slug: `^[a-z0-9][a-z0-9-]{0,31}$`  
- `sessionKey`: `{parentSessionKey}--{slug}`  
- `branch`: `acpbot/{safeParentLeaf}--{slug}`  

### Authorization

Same as before: parent may send/wait/kill only its `byParent` children; child may message parent; no sibling mesh v1.

---

## MCP tools (only surface)

| Tool | Worktree-related behavior |
|---|---|
| `agent_spawn` | Create branch + worktree → create topic session with `cwd=worktree` → ensure host slot → optional prompt |
| `agent_list` | Include `branch`, `worktreePath`, status |
| `agent_send` / `agent_wait` / `agent_status` | Unchanged A2A |
| `agent_kill` | Cancel turn; optionally remove worktree / keep branch |

```ts
agent_spawn({
  name: "impl-auth",
  agent?: "codex",
  role?: "implementer",
  prompt?: "…",
  permission_mode?: "ask" | "bypass",
  // v2: base_ref?: string
})
// → { runId, sessionKey, parentSessionKey, worktreePath, branch, status }
```

---

## Config

```toml
[agents.spawn]
enabled = true
max_children_per_parent = 4
max_depth = 2
max_concurrent_spawned = 8
default_child_permission = "ask"
worktree_root = ""   # empty → $state_dir/worktrees
branch_prefix = "acpbot/"
remove_worktree_on_kill = true
delete_branch_on_kill = false
require_git = true   # spawn fails if parent cwd is not a git work tree
```

---

## Architecture (extra module)

```text
src/core/agent-spawn-registry.ts   byChild / byParent
src/core/agent-worktree.ts         add/remove worktree, branch names, mutex per repo
src/mcp/server.ts                  agent_* tools
src/core/worker-api-server.ts      /v1/agents/*
src/core/daemon.ts                 orchestration
skills/multi-agent/SKILL.md
test/agent-worktree.test.ts
test/agent-spawn.test.ts
```

`agent-worktree.ts` uses `git -C <repo> worktree add|list|remove` (executable `git` on PATH).

---

## Plan → multi-agent implement (with worktrees)

```text
Parent plans in primary tree (operator topic)
  agent_spawn name=impl agent=codex
    → worktree + branch acpbot/plan--impl
    → implement only there
  agent_wait impl
  agent_spawn name=review agent=claude
    → another worktree; prompt: review branch acpbot/plan--impl
  agent_wait review
  Parent (or human) merges / opens PR from impl branch
```

---

## Phases (updated)

| Phase | Work |
|---|---|
| **1** | Registry + **worktree add** + `agent_spawn` / `list` / `kill` (dispose removes worktree) |
| **2** | `agent_send` + `agent_wait` + result summary |
| **3** | Skill (tools + worktree/branch habits) + `/sessions` indent + status shows branch |
| **4** | `base_ref` for review-on-impl-branch; cascade parent dispose; caps polish |

---

## Failure modes

| Case | Behavior |
|---|---|
| Not a git repo | `agent_spawn` fails: “multi-agent spawn requires git work tree” |
| Branch exists | Fail or suffix `-2` (v1: fail clearly) |
| Worktree path exists | Fail; do not reuse |
| `git worktree add` fails | No session/topic created (transaction: worktree first, then session, or rollback worktree) |
| Disk full | Fail spawn; no orphan session |

**Order of operations (atomic-ish):**

1. Validate parent, caps, slug  
2. `git worktree add`  
3. Create Telegram topic + PersistedSession (`cwd` = worktree, `parentSessionKey`)  
4. Spawn registry insert  
5. Host ensure + optional prompt  
6. On failure after 2: `worktree remove` + delete branch if we created it  

---

## Non-goals (v1)

- CLI spawn  
- Shared cwd / “same worktree” mode  
- Non-git repos  
- Auto-push / auto-PR (skill may instruct agent to `gh pr create` inside worktree)  
- `base_ref` / review-from-sibling (phase 4)  

---

## Effort

| Phase | Size |
|---|---|
| 1 Spawn + worktree + list/kill | 4–6 days |
| 2 Send/wait | 2–4 days |
| 3 Skill + UX | 1–2 days |

---


## Summary

- **MCP tools only**; parent-linked slots.  
- **Every child always runs in a new git worktree** on its own branch under `$state_dir/worktrees/…`, with `cwd` pointed there.  
- Kill/dispose can remove the worktree; branches kept by default for PRs.  
- Enables safe parallel implementers after a plan without trampling the parent tree.
