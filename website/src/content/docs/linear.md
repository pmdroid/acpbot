---
title: Linear
description: OAuth Linear MCP, topic↔project binding, work-through issues.
order: 13
section: reference
---

Bind a **Telegram topic** to a **Linear project**. The agent works through that
project’s issues using Linear’s official remote MCP (OAuth), while acpbot stores
only the topic↔project link on the host.

```text
Topic (session) ──binding──► Linear project
                                 │
                                 ▼
                           open issues = backlog
```

## Prerequisites

1. **OAuth callback** — same as other remote MCP: set `[oauth].callback_base`
   (`acpbot setup`). See [OAuth](/docs/oauth).
2. Host + worker sharing the same `state_dir` / config.

## Connect (once per repo)

In a session topic:

```text
/linear connect
```

This:

1. Writes `linear` → `https://mcp.linear.app/mcp` into `<repo>/.acpbot/mcp.json`
   (id + url only; **no tokens**)
2. Attaches a per-topic `mcp-proxy`
3. Starts browser OAuth (tappable URL in Telegram)

After authorize, Linear tools appear **without** restarting the agent.

Fallback paste: `/mcp code <full-callback-url>`  
Generic path: `/mcp add linear https://mcp.linear.app/mcp` then `/mcp auth linear`.

Tokens: `$state_dir/mcp-oauth/by-repo/<repoKey>/linear.json` (mode 0600).

## Bind topic ↔ project

| Command | Effect |
|---|---|
| `/linear project <id\|url\|name>` | Bind this topic |
| `/linear project` | Show binding; agent can list projects |
| `/linear unbind` | Clear binding only |
| `/linear` | OAuth + binding status |

Bindings live under `$state_dir/linear/bindings/` (not in git). Multiple topics
on the same repo can each track a different project. OAuth is still **per repo**.

### Agent tools (host MCP `acpbot`)

| Tool | Purpose |
|---|---|
| `linear_get_binding` | Read binding for this session |
| `linear_bind_project` | Save binding after creating/attaching a project |
| `linear_unbind_project` | Clear binding |

## Work through issues

| Command | Effect |
|---|---|
| `/linear export` | Agent: turn the plan into a Linear project + issues, then bind |
| `/linear next` | Agent: **one** open issue (In Progress → implement → Done) |
| `/linear work ENG-123` | Agent: focus one issue |
| `/linear fanout` | Agent: multi-agent — one child per open issue |

The agent uses **Linear MCP** for create/list/update/comment and **host
binding tools** so later turns stay scoped to the same project.

### Sticky context (every turn)

When a project is bound, free-text turns get a short `[Linear] Bound project …`
prefix so the agent keeps scoping work without re-running `/linear next`.
Structured `/linear *` prompts already include full context (not double-prefixed).

MCP children may also see non-secret env:

- `ACPBOT_LINEAR_PROJECT_ID`
- `ACPBOT_LINEAR_PROJECT_NAME` / `_URL` / `_LAST_ISSUE` when set  

(Env is applied when the session MCP list is built — after bind, a later ensure/respawn picks it up.)

### Visibility

- `/status` — Linear project line
- `/sessions` — project name (and last issue) under each session
- Binding via `/linear project` renames the forum topic with a project suffix (best-effort)

Skill: `/skills` → **linear** (plan export, one-issue loop, fan-out).

## Flows

### Plan → project → implement

1. Plan in the topic (`/plan` if useful).
2. `/linear connect` (once).
3. `/linear export` (or natural language + linear skill).
4. Confirm the proposed issues, then let the agent create + `linear_bind_project`.
5. `/linear next` or `/linear work <ISSUE>` until the project is done.

### Attach an existing project

```text
/linear project https://linear.app/…/project/…
# or
/linear project <project-uuid>
```

## Disconnect

```text
/linear disconnect           # drop OAuth token
/linear disconnect remove    # also remove mcp.json entry
/linear unbind               # clear topic binding only
```

## Security

- Same model as [OAuth](/docs/oauth): PKCE, host-only tokens, no secrets in the repo.
- Linear write access is powerful — the skill asks for confirmation before bulk creates.
- Operator is responsible for workspace permissions (same as shell-capable agents).

## Implementation map

| Area | Path |
|---|---|
| Binding store | `src/linear/bindings.ts` |
| Prompts | `src/linear/prompts.ts` |
| Known MCP URL | `src/mcp/known-remotes.ts` |
| Commands | `src/core/commands.ts`, `src/core/daemon.ts` |
| Host MCP tools | `src/mcp/server.ts` |
| Skill | `skills/linear/SKILL.md` |
