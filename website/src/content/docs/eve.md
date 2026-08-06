---
title: EVE
description: Background multi-agent directives — JS orchestration graphs (WALL-E-inspired).
order: 17
section: advanced
---

**EVE** (*Extraterrestrial Vegetation Evaluator*) runs multi-agent work as a **JavaScript directive** in the background. Control flow costs zero model tokens; only leaf `agent()` calls spawn ACP workers (usually headless, in git worktrees). Telegram stays free for progress, permissions, and questions.

Named after the probe in *WALL·E* — the fleet works; you only hear when there’s a plant (or a blocker). **Not ultracode.**

```text
You ──/eve run──► worker ──script──► agent() × N (worktrees)
                      │
                      └── digests / ❓ / ✅ on the topic
```

Design note: [docs/ideas/workflows.md](https://github.com/pmdroid/acpbot/blob/main/docs/ideas/workflows.md).

## When to use it

| Situation | Approach |
|---|---|
| One implementer after a plan | [Multi-agent](/docs/multi-agent) `agent_spawn` |
| One Linear issue | `/linear next` |
| Drain a bound Linear project unattended | **`/linear drain`** (bundled `linear-drain`) |
| Multi-file audit / parallel graph | `/eve run …` or agent `eve_write` + `eve_run` |

## Operator commands

| Command | Effect |
|---|---|
| `/eve` | Status, scripts, recent runs |
| `/eve run <name>` | Start a directive (may wait for approve) |
| `/eve approve <runId>` | Start a pending run |
| `/eve status [runId]` | Progress + log |
| `/eve list` | Scripts + runs |
| `/eve pause` / `resume` / `kill` | Control |
| `/directive` | Alias for `/eve` |
| `/linear drain` | Bundled Linear ready-set drain |

## Script layout

| Scope | Path |
|---|---|
| Project | `<repo>/.acpbot/eve/<name>.js` |
| User | `$state_dir/eve/directives/<name>.js` |
| Bundled | `linear-drain`, `audit-routes` |

```js
export const meta = {
  name: 'audit-routes',
  description: 'Audit handlers for missing auth',
  phases: [{ title: 'Discover' }, { title: 'Audit' }],
}

const found = await agent('List route files…', {
  schema: { type: 'object', required: ['files'], properties: {
    files: { type: 'array', items: { type: 'string' } },
  }},
})

const audits = await pipeline(found.files, (file) =>
  agent(`Audit ${file}`, { label: file }),
)

return audits.filter(Boolean)
```

Injected: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `host`, `workflow`.

## MCP tools

Server **`acpbot`**: `eve_list`, `eve_run`, `eve_approve`, `eve_status`, `eve_pause`, `eve_resume`, `eve_kill`, `eve_write`.

Skill: **`eve`** (`acpbot skills install`).

## Config

```toml
[eve]
enabled = true
max_agents_per_run = 100
max_concurrent = 4
schema_retries = 2
require_approval = true
default_agent = "codex"
```

Hard ceilings still apply from `[agents.spawn]`. Leaf children free spawn slots after each node finishes.

## Schedules

Create a schedule whose prompt asks the agent to `eve_run({ name: "linear-drain" })`, or (later) fire a named directive directly. Host ticker + existing [Schedules](/docs/schedules) apply.

## Related

- [Multi-agent](/docs/multi-agent) — node runtime (worktrees)
- [Linear](/docs/linear) — project binding + `/linear drain`
- [Schedules](/docs/schedules) — durable kicks
