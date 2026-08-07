---
name: linear
description: >
  Linear via acpbot: OAuth MCP tools for issues/projects, plus host binding so
  this Telegram topic is tied to one Linear project. Use when exporting a plan
  to Linear, working the bound project's backlog, fan-out, or updating issue status.
---

# Linear (acpbot)

This topic can be **bound** to one Linear project. That project is the backlog
you work through. Linear data lives in Linear; acpbot only stores the binding.

Free-text turns may include a sticky `[Linear] Bound project …` prefix when
bound — honor it. Env may also set `ACPBOT_LINEAR_PROJECT_ID` (and optional
name/url/last issue) on MCP children after (re)spawn.

## Setup (operator)

1. `[oauth].callback_base` configured (`acpbot setup`)
2. `/linear connect` — registers official MCP + browser OAuth
3. `/linear project <id|url>` **or** create via export and `linear_bind_project`

Official MCP: `https://mcp.linear.app/mcp` (id **`linear`**).

## Host MCP tools (`acpbot`)

| Tool | Purpose |
|---|---|
| `linear_get_binding` | Read topic↔project binding |
| `linear_bind_project` | Save binding after create/attach; set `lastIssueId` when focusing |
| `linear_unbind_project` | Clear binding (does not delete Linear data) |

## Linear MCP tools (`linear`)

Use the **Linear** remote MCP (after OAuth) to list/create/update projects,
issues, comments, and statuses. Prefer those tools over shell/`curl`.

## Always scope to the bound project

```
linear_get_binding({})
```

If bound, filter issue list/create to that `projectId`. Do not wander the
whole workspace unless the operator asks.

## One issue at a time

Unless the operator asks for fan-out or multi-issue work:

1. Pick **one** open issue
2. In Progress → implement → comment → Done (or blocked)
3. Do **not** start a second issue in the same turn
4. Refresh `lastIssueId` via `linear_bind_project`

## Recipes

### Plan → Linear project

1. Finish the plan with the operator (often after `/plan`).
2. Propose project name, milestones (only if clear phases), and issues
   (title + problem/goal/approach/open questions).
3. Wait for confirmation before bulk create.
4. Create via Linear MCP.
5. `linear_bind_project({ projectId, projectName, projectUrl?, teamId?, teamKey?, boundBy: "export" })`
6. Reply with links/ids.

Operator shortcut: `/linear export`.

### Work the bound project (`/linear next`)

1. `linear_get_binding`
2. List open issues in that project only
3. Choose the best next (unblocked, priority); if `/linear next` was used, proceed
   unless two candidates are tied
4. In Progress + comment; set `lastIssueId`
5. Implement; `update` for progress
6. Comment + Done (or blocked); suggest another `/linear next`

### Single issue (`/linear work ENG-123`)

Same loop forced onto one identifier.

### Multi-agent fan-out (`/linear fanout`)

After the project is bound:

1. List open issues; show spawn plan; confirm unless operator already approved
2. For each ready issue (respect spawn caps):  
   `agent_spawn({ name: "<issue-slug>", prompt: "Implement only ISSUE … acceptance …" })`  
   Prefer default headless children
3. `agent_wait` per child
4. On success: Linear comment + Done; on failure: comment blocker
5. Summarize to the operator

See the **multi-agent** skill for spawn/wait rules. Parent is A2A hub only.

## Do not

- Put Linear tokens or OAuth secrets in the repo or prompts
- Create bulk issues without operator confirmation
- Ignore a bound project id when one is set
- Start multiple issues in one non-fanout turn
- Assume Linear MCP tools exist before `/linear connect` / OAuth

## Operator commands

| Command | Effect |
|---|---|
| `/linear` | Status |
| `/linear connect` | MCP + OAuth |
| `/linear project <id\|url>` | Bind topic (+ topic title suffix) |
| `/linear export` | Plan → project agent turn |
| `/linear next` | One next open issue |
| `/linear work <ISSUE>` | Focus one issue |
| `/linear fanout` | Multi-agent one child per open issue |
| `/linear drain` | Agent **writes + runs** an EVE drain directive (see **eve** skill) |
| `/linear unbind` | Clear binding |
