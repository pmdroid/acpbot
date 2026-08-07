---
title: EVE
description: Background multi-agent directives — JS orchestration graphs (WALL-E-inspired).
order: 17
section: advanced
---

**EVE** (*Extraterrestrial Vegetation Evaluator*) runs multi-agent work as a **JavaScript directive** in the background. Control flow costs zero model tokens; only leaf `agent()` calls pay for ACP workers (slots + git worktrees). Telegram stays free for progress, permissions, and questions.

Named after the probe in *WALL·E* — the fleet works; you only hear when there’s a plant (or a blocker). **Not ultracode.**

**Orchestration runs on `acp-host`**, not the Telegram worker. If the worker restarts mid-run, the graph keeps going; digests arrive as `eve_notify` when a worker is connected.

```text
You ──/eve run──► worker (control + Telegram)
                      │
                      ▼
                 acp-host ── JS directive ──► agent() × N (slots + worktrees)
                      │
                      └── eve_notify ──► worker ──► digests / ❓ / ✅ on the topic
```

Design note: [docs/ideas/workflows.md](https://github.com/pmdroid/acpbot/blob/main/docs/ideas/workflows.md).

## When to use it

| Situation | Approach |
|---|---|
| One implementer after a plan | [Multi-agent](/docs/multi-agent) `agent_spawn` |
| One Linear issue | `/linear next` |
| Drain a bound Linear project unattended | **`/linear drain`** → agent **authors** an EVE script + `eve_run` |
| Multi-file audit / parallel graph | Agent `eve_write` + `eve_run` (or inline `source`) |

**No shipped directive scripts.** Names like `linear-drain` only exist after an agent
(or you) writes them under `.acpbot/eve/`. The **eve** skill teaches agents how.

## Operator commands

| Command | Effect |
|---|---|
| `/eve` | Status, scripts, recent runs |
| `/eve run <name>` | Start a project/user directive (may wait for approve) |
| `/eve approve <runId>` | Start a pending run |
| `/eve status [runId]` | Progress + log |
| `/eve list` | Scripts + runs |
| `/eve pause` / `resume` / `kill` | Control |
| `/directive` | Alias for `/eve` |
| `/linear drain` | Agent turn: write + start an EVE drain for the bound project |

## Script layout

| Scope | Path |
|---|---|
| Project | `<repo>/.acpbot/eve/<name>.js` |
| User | `$state_dir/eve/directives/<name>.js` |

```js
export const meta = {
  name: 'audit-routes',
  description: 'Audit handlers for missing auth',
  phases: [{ title: 'Discover' }, { title: 'Audit' }],
}

phase('Discover')
const found = await agent('List route files…', {
  schema: { type: 'object', required: ['files'], properties: {
    files: { type: 'array', items: { type: 'string' } },
  }},
})

phase('Audit')
const audits = await pipeline(found.files, (file) =>
  agent(`Audit ${file}`, {
    label: String(file).split('/').pop(),
    schema: {
      type: 'object',
      required: ['file', 'issues'],
      properties: {
        file: { type: 'string' },
        issues: { type: 'array', items: { type: 'object' } },
      },
    },
  }),
)

return (audits || []).filter(Boolean)
```

Injected: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `host`, `workflow`.
See the **eve** skill for full API, recipes (Linear drain, audit, plan→impl→verify), and rules.

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
default_agent = "grok-build"
```

Hard ceilings still apply from `[agents.spawn]`. Leaf children free spawn slots after each node finishes.

## Schedules

Create a schedule whose fire prompt has the agent **author or reuse** a project
script (`eve_write` / `.acpbot/eve/…`) then `eve_run({ name: "…" })`. Do not
assume built-in names. Host ticker + existing [Schedules](/docs/schedules) apply.

## Related

- [Multi-agent](/docs/multi-agent) — node runtime (worktrees)
- [Linear](/docs/linear) — project binding; `/linear drain` authors an EVE graph
- [Schedules](/docs/schedules) — durable kicks
