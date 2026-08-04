---
name: multi-agent
description: >
  Spawn parent-linked child ACP agents via host MCP tools (agent_spawn / list /
  send / wait / kill). Each child runs in a new git worktree. Use after a plan
  to fan out implementers; parent is the A2A hub.
---

# Multi-agent spawn (acpbot MCP)

Host MCP server: **`acpbot`**. Tools (no CLI in v1):

| Tool | Purpose |
|---|---|
| `agent_spawn` | Create child session + **new git worktree** + optional kickoff prompt |
| `agent_list` | List children of **this** session |
| `agent_send` | Message a child (slug) or `parent` |
| `agent_wait` | Wait until child idle/done/failed (returns summary) |
| `agent_kill` | Cancel child; dispose worktree (branch kept by default) |

## Rules

- Parent cwd is never shared — every child has its own branch under `$state_dir/worktrees/…`
- Parent hub only: no sibling-to-sibling mesh
- Caps: depth and max children (config `[agents.spawn]`)
- Parent must be a **git** work tree or spawn fails
- Do not put secrets in A2A messages

## Plan → implement recipe

1. Finish the plan with the operator in this topic
2. `agent_spawn({ name: "impl", agent: "codex", prompt: "…" })`
3. `agent_wait({ to: "impl" })`
4. Optionally `agent_spawn` a reviewer; or merge/PR from the child branch yourself
5. Summarize to the operator

## Example

```
agent_spawn({
  name: "impl-auth",
  agent: "codex",
  role: "implementer",
  prompt: "Implement section 2 of the plan in this worktree only. Report files changed."
})
agent_wait({ to: "impl-auth", timeout_sec: 900 })
agent_list({})
```
