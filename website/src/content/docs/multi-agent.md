---
title: Multi-agent
description: Parent agents spawn children via MCP tools; parent-linked slots and always-new git worktrees.
order: 16
section: advanced
---


A **parent** agent (already in a Telegram topic) can spawn **child** ACP agents through the built-in **`acpbot` MCP server**. acpbot owns lifecycle, links every child to its parent, runs each child in a **new git worktree** (never the parent cwd), and provides a simple **agent-to-agent (A2A)** bridge so you can plan in one topic and implement in others.

There is **no CLI** for spawn in v1 — only MCP tools (+ a bundled skill).

Design background: [multi-agent design note](https://github.com/pmdroid/acpbot/blob/main/docs/ideas/multi-agent-spawn.md) (repo).

## When to use it

| Situation | Approach |
|---|---|
| Single agent implements the plan | Normal topic replies — no spawn |
| Plan done; want a dedicated implementer (e.g. Codex) | `agent_spawn` + `agent_wait` |
| Parallel workstreams | Multiple spawns, then wait on each (respect caps) |
| Grok’s internal subagents only | Leave them — they stay inside one process; not first-class acpbot sessions |

## Model

```text
Operator ── topic parent (e.g. work/plan)
                 │
                 │ MCP agent_spawn / send / wait / kill
                 ▼
              acpbot worker + host
                 │  parentSessionKey links
                 ├─► work/plan--impl    worktree + branch acpbot/plan--impl
                 └─► work/plan--review  another worktree
```

### Invariants

1. **Parent link** — every child has immutable `parentSessionKey` (the parent’s session key / host slot).  
2. **Worktree** — every spawn creates a **new** `git worktree` + branch; child `cwd` is never the parent tree.  
3. **Hub** — parent may message its children; child may message parent; **sibling mesh is denied** in v1.

Parent must be a **git** work tree or spawn fails clearly.

## MCP tools

Host MCP server: **`acpbot`** (same server as `update`, `schedule_*`, …).

| Tool | Purpose |
|---|---|
| `agent_spawn` | Create child session + worktree + optional kickoff prompt |
| `agent_list` | List children of **this** session |
| `agent_send` | Message a child (slug or session key) or `"parent"` |
| `agent_wait` | Wait until child idle/done/failed/killed (or timeout); returns summary |
| `agent_kill` | Cancel child; dispose worktree by default (branch kept for PRs) |

### Examples

```text
agent_spawn({
  name: "impl-auth",
  agent: "codex",
  role: "implementer",
  prompt: "Implement section 2 of the plan in this worktree only. Report files changed."
})

agent_wait({ to: "impl-auth", timeout_sec: 900 })

agent_list({})

agent_send({ to: "impl-auth", message: "Open a PR from your branch when green." })

agent_kill({ to: "impl-auth" })
```

- `name` is a short slug `[a-z0-9-]` → session key `{parent}--{name}` (e.g. `work/plan--impl-auth`).  
- After a kickoff `prompt`, spawn finishes with **idle** status and a durable **last result summary** so `agent_wait` works without extra marks.

## Worktrees and branches

| Item | Default |
|---|---|
| Worktree path | `$state_dir/worktrees/{repo}/{childSessionKey}/` |
| Branch | `acpbot/{parentLeaf}--{slug}` |
| Base | Parent `HEAD` (committed) |
| On kill + dispose | Remove worktree; **keep branch** (for PR) unless configured otherwise |

Children edit only their tree. Integrate via git merge/PR from the child branch — not by sharing the parent dirty working copy.

## Config (optional caps)

```toml
[agents.spawn]
# enabled = true
# max_children_per_parent = 4
# max_depth = 2
# max_concurrent_spawned = 8
# remove_worktree_on_kill = true
# delete_branch_on_kill = false
```

## Skill

Bundled skill **`multi-agent`** teaches the tools and the plan→implement recipe:

```bash
acpbot skills install
```

Also listed under [Skills](/docs/skills).

## Operator UX

- Spawn posts a short notice in the **parent** topic (child session key, worktree path, thread).  
- Child is a normal forum topic: permissions, `/status`, free-text, etc.  
- Registry is durable under `$state_dir/agent-spawns.json`.

## Limits (v1)

- MCP tools only (no `acpbot agent …` CLI)  
- No headless children (always a Telegram topic)  
- No sibling-to-sibling messaging without the parent  
- No `base_ref` / review-on-sibling-branch yet  
- Multi-host: children follow the **parent repo’s host** binding when multi-host is configured — see [Multi-host](/docs/multi-host) if that page is in your build

## Related

- [MCP](/docs/mcp) — built-in `acpbot` tools  
- [Skills](/docs/skills) — install bundled skills  
- [Agents](/docs/agents) — agent binaries and `/agent`  
- [Architecture](/docs/architecture) — worker + host process model  
