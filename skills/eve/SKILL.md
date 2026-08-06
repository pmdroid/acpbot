---
name: eve
description: >
  EVE (Extraterrestrial Vegetation Evaluator) — background multi-agent
  directives. Agent-authored JS graphs run on the host/worker with zero-token
  orchestration; leaf agent() calls use worktrees. Prefer for Linear drain,
  multi-file audits, and long parallel jobs. Not ultracode.
---

# EVE — background directives

Named after WALL-E’s probe: **EVE runs the fleet while you wait for the plant.**

Host MCP tools (`acpbot`):

| Tool | Purpose |
|---|---|
| `eve_list` | Scripts + recent runs |
| `eve_run` | Start by name / path / inline `source` |
| `eve_approve` | Approve pending run |
| `eve_status` / `eve_pause` / `eve_resume` / `eve_kill` | Control |
| `eve_write` | Save `.acpbot/eve/<name>.js` |

Operator: `/eve`, `/linear drain`, alias `/directive`.

## When to use EVE vs multi-agent chat

| Situation | Use |
|---|---|
| One implementer after a plan | `agent_spawn` (multi-agent skill) |
| One Linear issue interactively | `/linear next` |
| Drain a project unattended | **`eve_run` `linear-drain`** or `/linear drain` |
| Multi-stage parallel graph | **Write an EVE script** |

## Script shape

```js
export const meta = {
  name: 'my-directive',
  description: 'What it does',
  phases: [{ title: 'Discover' }, { title: 'Work' }],
}

phase('Discover')
const found = await agent('…', { schema: { type: 'object', … } })
const results = await pipeline(found.items, (item) =>
  agent(`Work on ${item}`, { label: item.id, isolation: 'worktree' }),
)
return results.filter(Boolean)
```

Injected: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `host`, `workflow`.

Rules:

- No `fs` / shell in the orchestrator — only `agent()` touches the world
- Prefer JSON `schema` on every `agent()` return
- Guard loops with `budget.ok()`
- Failed agents resolve to `null` — `.filter(Boolean)`
- Do not put secrets in scripts

## Authoring loop

1. Draft script (or `eve_write`)
2. `eve_run({ name })` or inline `source`
3. Tell operator to `/eve approve <runId>` if pending
4. `eve_status` for progress; summarize when complete

## Bundled

- `linear-drain` — open unblocked Linear issues → implement → close
- `audit-routes` — list files → audit each → synthesize

## Do not

- Call it ultracode
- Orchestrate long fan-out only in chat context
- Ignore spawn caps / budget
