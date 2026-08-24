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
| One GitHub issue | Work it in the topic (`gh issue view`) |
| Drain open GitHub issues unattended | Agent **authors** an EVE script + `eve_run` |
| Multi-file audit / parallel graph | Agent `eve_write` + `eve_run` (or inline `source`) |

**No shipped directive scripts.** Names like `issue-drain` only exist after an agent
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
| `/eve answer <runId> <n>` | Answer a parked `waiting_user` question (or tap the Telegram buttons) |
| `/directive` | Alias for `/eve` |

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

Injected: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `host` (including **`host.ask`**), `workflow`.
See the **eve** skill for full API, recipes (GitHub issue drain, audit, plan→impl→verify), and rules.

### Blocked is not complete

A directive that returns `{ blocked: 1 }` (or any leaf `status: "blocked"`) is **not**
a successful plant. The host:

1. Parks the run as **`waiting_user`**
2. Asks you on Telegram (buttons + `/eve answer`) — keep fixing / continue / stop
3. Only then marks the run finished, with your decision on `finalResult.operatorDecision`

Scripts should **`await host.ask({ question, options })`** *before* returning so they
can continue the stack after you answer. The auto-ask is a safety net so a
`stopOnBlocked` graph cannot die quietly behind `🌱 EVE complete`.

## Leaf handoff (schema + digests)

Each `agent()` leaf is a **headless** ACP slot (worktree + bypass tool policy). When the leaf finishes, the host:

1. Collects the assistant **output text** (`text_delta`, not thought stream)
2. Parses JSON (fenced json code block preferred)
3. Validates against your `schema` when provided
4. Retries up to `[eve].schema_retries` with a fix-up hint if validation fails

| Outcome | Digest | `agent()` return |
|---|---|---|
| Valid JSON | counted as done | parsed object |
| Agent **completed** but missing/invalid JSON | ⚠️ partial | soft object when it can still match schema (e.g. `{ status: "partial", summary, issueId }` from the leaf `label`) |
| Hard failure / kill / no recoverable shape | 🚫 failed (listed) | `null` |

**Always** treat results as nullable: `.filter(Boolean)` and check `status`. Prefer tight schemas and ask leaves to **end with a JSON fence** after the real work (commit/push), not tools-only silence.

Log lines like `schema soft-ok … → partial` mean the leaf shipped work but the structured handoff was filled in by the host — not a silent drop.

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
digest_interval_sec = 300   # ignored unless 0 (debug: every log/leaf line)
default_agent = "grok-build"
```

Telegram stays **silent** except when the run is **done** or **you need to act** (approve, `host.ask`, blocked). `log()` and leaf ✅/🚫 stay in the run log (`/eve status`) — they do not post. Set `digest_interval_sec = 0` only to debug with the old per-line chatter.

Hard ceilings still apply from `[agents.spawn]`. Leaf children free spawn slots after each node finishes.

## Schedules

Create a schedule whose fire prompt has the agent **author or reuse** a project
script (`eve_write` / `.acpbot/eve/…`) then `eve_run({ name: "…" })`. Do not
assume built-in names. Host ticker + existing [Schedules](/docs/schedules) apply.

## Related

- [Multi-agent](/docs/multi-agent) — node runtime (worktrees)
- [Schedules](/docs/schedules) — durable kicks
