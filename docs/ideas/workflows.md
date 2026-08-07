# Idea: Host-side dynamic workflows (agent-authored JS graphs)

**Status:** implemented as **EVE** (2026-08-06; host runner 2026-08-07) — see [website docs /eve](../../website/src/content/docs/eve.md), `src/eve/`, `/eve`.  
**Note (2026-08-07):** shipped/bundled directive scripts (`linear-drain`, `audit-routes`) were **removed**. Agents author graphs via `eve_write` + `eve_run` (skill-driven). `/linear drain` is an agent turn that writes a drain directive, not a built-in script. Historical “bundled workflow” language below is design-era.

**Brand:** Extraterrestrial Vegetation Evaluator (WALL·E) — not ultracode.  
**Process:** orchestration + leaf slots on **acp-host**; worker is control plane + Telegram only.

Related:

- [multi-agent-spawn.md](./multi-agent-spawn.md) — **node runtime** (parent-linked slots, worktrees, A2A). Multi-agent is largely **shipped**; this doc assumes it.
- [multi-host-http3.md](./multi-host-http3.md) — **where** agents run.
- Product docs: [Multi-agent](https://acpbot.app/docs/multi-agent), [Linear](https://acpbot.app/docs/linear), [Schedules](https://acpbot.app/docs/schedules).
- External reference: [Claude Code Dynamic Workflows](https://code.claude.com/docs/en/workflows) (script holds the plan; runtime executes; leaf `agent()` calls pay tokens).

This doc is **how the graph runs in the background**: a small JS orchestration script owns topology; acp-host executes it; Telegram is only human I/O (progress, permissions, questions).

---

## Intent

Today acpbot can:

| Capability | Surface |
|---|---|
| Long-lived agents | acp-host owns stdio slots |
| Parallel implementers | `agent_spawn` + worktree + `agent_wait` |
| Linear backlog | bind project, `/linear next` / `work` / `fanout` |
| Durable kicks | schedules under `<repo>/.acpbot/schedules/` |
| Human channel | Telegram topic; headless children route permissions / `ask_user` to parent |

What is still a **chatty linear agent**:

- `/linear next` — human restarts each issue.
- `/linear fanout` — parent agent spends context to spawn/wait and “remember” the plan.
- No **versioned, zero-token orchestration** the agent can write once and the host can rerun overnight.

**Goal:** Claude Code–style **dynamic workflows**:

1. An agent (or human) writes a small **JavaScript orchestration script**.
2. **acp-host** runs that script in a sandboxed runtime (**zero model tokens** for control flow).
3. Leaf **`agent()`** calls map to ACP child sessions (reuse multi-agent spawn / worktrees).
4. Intermediate results live in **script variables**, not a parent context window.
5. Telegram surfaces only: approve script, progress digests, permissions, structured questions, final summary.
6. First product killer: **Linear drain** — work a bound project’s ready issues until dry, with human-in-the-loop only when blocked or asked.

```text
Operator (Telegram)          Workflow runtime (host)           Workers (ACP)
        │                            │                              │
        │  /workflow run linear-drain│                              │
        │  or agent writes + launches│                              │
        │───────────────────────────►│  load script + args          │
        │  approve phases?           │                              │
        │◄───────────────────────────│                              │
        │  Yes                       │                              │
        │───────────────────────────►│  parallel / pipeline         │
        │                            │──agent() / spawn────────────►│
        │  ⏳ ENG-12 implementing    │◄──update / progress──────────│
        │  ❓ ENG-15 which API?      │◄──ask_user (pause node)──────│
        │───────────────────────────►│──resume that node only──────►│
        │  ✅ ENG-12 done + PR       │  host reduce → Linear        │
        │  … overnight …             │  next ready issues           │
```

---

## Core invariants

1. **Script owns topology.** Loops, branches, fan-out, barriers, and reduce steps are plain JS. They must not require an LLM turn.
2. **Agents own I/O.** The orchestrator has no direct filesystem, shell, network, or Telegram. Only `agent()` (and host-injected helpers) touch the world.
3. **Nodes are contracts.** Prefer JSON Schema on every `agent()` return so edges are typed; validation + retry at the tool layer, not free-text prayer.
4. **Isolation for writers.** Parallel mutators use multi-agent worktrees (already the default on `agent_spawn`).
5. **Human edges are first-class.** Unlike Claude Code’s “no mid-run user chat,” acpbot **must** pause a single node on permission / elicitation / `ask_user` and resume without killing the graph.
6. **Durable run state on the host.** Runs survive worker restarts; resume is host-owned, not “same chat session only.”
7. **Caps always win.** Spawn caps, concurrency, agent budget, wall-clock budget — scripts cannot override hard host limits.

---

## Why not “parent agent orchestrates via MCP”

| Parent agent as orchestrator (today) | Host workflow runtime (this idea) |
|---|---|
| Plan in context window | Plan in script variables |
| Forgets / fills window on long drains | Deterministic replay + cached node results |
| Coordination burns tokens | Edges free; only leaves cost tokens |
| Stops when turn ends | Runs until dry / budget / kill |
| Hard to version or rerun | `.acpbot/workflows/*.js` in git |
| Fanout skill is procedural prose | Same graph every night via schedule |

Parent-agent orchestration remains valid for **ad-hoc** multi-agent (plan → one impl → review). Workflows are for **repeatable, parallelizable, long-running** graphs — especially Linear backlog drain.

---

## Claude Code mapping (what we copy / adapt)

Reference: [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows).

| Claude Code | acpbot target |
|---|---|
| JS script + `meta` export | Same shape under `.acpbot/workflows/` |
| Runtime executes in background | **acp-host** workflow runner |
| `agent()` / `parallel()` / `pipeline()` | Injected globals; `agent()` → spawn or slot prompt |
| `schema` on agent | Validate + retry structured result |
| `isolation: 'worktree'` | Always-on for spawn (existing) |
| `/workflows` UI | Telegram: progress, pause, resume, stop, save |
| Save to `.claude/workflows/` | Save to `.acpbot/workflows/` (+ optional user dir) |
| `args` global | Slash / schedule / Linear binding payload |
| `budget` | Token + agent-count + wall-clock |
| No mid-run free user input | **Adapt:** `waiting_user` node state + Telegram brokers |
| Resume same session only | **Stronger:** durable run JSON on host |
| Approval before run | Telegram inline keyboard (View script / Run / Deny) |

---

## Surfaces

| Surface | v1 | Notes |
|---|---|---|
| **Host runtime** | Required | Executes scripts; owns run state |
| **MCP tools** (`acpbot`) | Required | Agent can write/list/run/wait workflows |
| **Telegram commands** | Required | Operator control without an agent turn |
| **CLI** | Optional later | e.g. `acpbot workflow run …` for CI |
| **Skill** | Required | Teach agent when/how to author scripts |

Decision: **host + MCP + Telegram first.** CLI is polish.

---

## Script shape

### Location

| Scope | Path | Visibility |
|---|---|---|
| Project (preferred) | `<repo>/.acpbot/workflows/<name>.js` | Git-shared |
| User / machine | `$state_dir/workflows/<name>.js` | Personal |
| Bundled | shipped with acpbot (e.g. `linear-drain`) | Always available |
| Ephemeral run | `$state_dir/workflow-runs/<runId>/script.js` | Auto-written when agent authors ad-hoc |

Project name wins over user name when both exist. Bundled names are reserved or namespaced (`builtin:linear-drain`).

### Module contract

```js
/**
 * Pure-literal meta only — host may extract statically for approval UI
 * without executing the body.
 */
export const meta = {
  name: 'linear-drain',
  description: 'Work open Linear issues in the bound project until dry',
  phases: [
    { title: 'Discover' },
    { title: 'Implement' },
    { title: 'Close' },
  ],
}

/**
 * Body: plain JS, top-level await allowed.
 * Runtime injects: agent, parallel, pipeline, phase, log, args, budget, host
 */
const open = await agent('List open issues in the bound Linear project only.', {
  phase: 'Discover',
  label: 'list-issues',
  schema: {
    type: 'object',
    required: ['issues'],
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'identifier', 'title', 'body', 'blockedBy'],
          properties: {
            id: { type: 'string' },
            identifier: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
            blockedBy: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
})

const ready = open.issues.filter((i) => (i.blockedBy ?? []).length === 0)
log(`Ready issues: ${ready.length}`)

const results = await pipeline(
  ready,
  (issue) =>
    agent(
      [
        `Implement ONLY ${issue.identifier}: ${issue.title}`,
        '',
        issue.body,
        '',
        'Do not touch other issues. Open a PR if appropriate.',
        'Return structured status when done or blocked.',
      ].join('\n'),
      {
        phase: 'Implement',
        label: issue.identifier,
        agent: 'grok-build', // optional override
        isolation: 'worktree',
        schema: {
          type: 'object',
          required: ['status', 'summary'],
          properties: {
            status: { type: 'string', enum: ['done', 'blocked'] },
            summary: { type: 'string' },
            prUrl: { type: 'string' },
            branch: { type: 'string' },
          },
        },
      },
    ),
)

const ok = results.filter(Boolean)

// Host helper: update Linear from validated node results (no LLM)
await host.linearApplyResults(ok)

return {
  done: ok.filter((r) => r.status === 'done').length,
  blocked: ok.filter((r) => r.status === 'blocked').length,
}
```

### Determinism constraints (resume safety)

Blocked or throw in orchestrator scope:

- `Date.now()`, `Math.random()`, non-literal `new Date()`
- `require` / dynamic import of host modules (except injected API)
- Direct `fs`, `fetch`, `child_process`, Telegram, Linear tokens

Timestamps and seeds must come from `args` or `host.now()` only if the host records the value at run start for replay. Prefer pure functions of `args` + prior `agent()` results.

---

## Runtime API (injected)

### `agent(prompt, options?) → result | null`

Spawns or prompts one worker. **One bounded job, one return value.**

| Option | Type | Purpose |
|---|---|---|
| `schema` | JSON Schema | Validate return; host retries agent on mismatch (cap N) |
| `label` | string | Progress / Telegram line |
| `phase` | string | Group under meta phase |
| `model` / `agent` | string | Route cheap vs judgment nodes |
| `isolation` | `'worktree'` \| `'none'` | Default `worktree` for mutators; `none` only for read-only audit if we allow later |
| `role` | string | Spawn registry role (`implementer`, `reviewer`, …) |
| `timeout_sec` | number | Hard stop → `null` |
| `permission_mode` | string | Inherit parent / ask / bypass (capped by config) |

**Semantics:**

- Fresh context (child session); does not share parent chat history.
- Unrecoverable failure / kill / timeout → **`null`** (never rejects the whole `parallel`/`pipeline` unless script throws).
- Mid-run permission / `ask_user` → node state `waiting_user`; **script await parks that node only**; other parallel nodes continue.
- After human answers (existing Telegram brokers), host resumes that node; `agent()` eventually resolves.

Implementation bridge (v1):

```text
agent() → agent_spawn({ name: slug, prompt, agent, headless: true })
       → agent_wait until idle/done/failed/waiting_user
       → parse lastResultSummary or structured MCP mark against schema
       → return object | null
```

Structured return path: extend multi-agent so a child can call something like `workflow_return({ ... })` or write a validated envelope the wait path already surfaces. Free-text summary is fallback only.

### `parallel(thunks: (() => Promise)[]) → any[]`

Barrier fan-out. Results in input order. Failed thunk → `null` in slot. Cap by `max_concurrent_spawned` / workflow concurrency; excess queues.

**Use when** the next stage needs the full set (dedupe, rank, early-exit on empty).

### `pipeline(items, ...stages) → any[]`

Each item flows through stages independently; no global barrier between items. Stage fn: `(prev, item, index) => Promise`.

**Use when** items are independent (ready Linear issues, per-file audit). **Default** for multi-item work.

### `phase(title)` / `log(message)`

Observability only. Telegram digest + run log file. `phase` updates active phase for subsequent agents that omit `opts.phase`.

### `args`

Invocation input. Examples:

- Linear: `{ projectId, maxIssues, agent: 'grok-build' }`
- Audit: `{ paths: ['src/routes'] }`
- From schedule fire envelope or slash args

If omitted → `undefined`.

### `budget`

| Method / field | Meaning |
|---|---|
| `budget.agentsMax` | Hard cap for this run (host) |
| `budget.agentsUsed()` | Count of `agent()` starts |
| `budget.remainingAgents()` | Headroom |
| `budget.deadlineAt` | Optional wall-clock end |
| `budget.ok()` | `remainingAgents > 0 && now < deadline` |

Scripts **must** guard open loops:

```js
while (dry < 2 && budget.ok()) {
  // discovery round
}
```

### `host` (acpbot-specific helpers)

Small, audited host functions — **not** a general Node API:

| Helper | Purpose |
|---|---|
| `host.linearListOpen(projectId?)` | Optional fast path without a list agent |
| `host.linearApplyResults(results)` | Comment + Done/blocked from schema results |
| `host.sessionKey` / `host.repoKey` | Bind context |
| `host.sleep(ms)` | Backoff (recorded for replay policy TBD) |

Prefer pure script + `agent()` for v0; add `host.*` only where LLM is pure waste (Linear status flips).

### Nested `workflow(name, args?)` (phase 2)

Run a saved workflow inline. One level of nesting max in v1 if implemented at all.

---

## Run state (durable)

```text
$state_dir/workflow-runs/<runId>.json
$state_dir/workflow-runs/<runId>/script.js    # frozen copy
$state_dir/workflow-runs/<runId>/nodes/       # optional per-node logs
```

```ts
type WorkflowRun = {
  runId: string
  name: string
  sessionKey: string          // operator / parent topic
  repoKey: string
  status:
    | 'pending_approval'
    | 'running'
    | 'paused'
    | 'waiting_user'          // at least one node waiting
    | 'completed'
    | 'failed'
    | 'killed'
  scriptPath: string          // frozen copy
  args?: unknown
  phases: { title: string; status: string; agentCount: number }[]
  nodes: Record<
    string, // stable node key: hash(phase,label,index,promptHash) or sequential id
    {
      status: 'pending' | 'running' | 'waiting_user' | 'done' | 'failed' | 'skipped'
      childSessionKey?: string
      result?: unknown        // validated schema object
      error?: string
      startedAt?: number
      finishedAt?: number
    }
  >
  /** Completed agent() results for resume/replay */
  resultCache: Record<string, unknown | null>
  budget: { agentsMax: number; agentsUsed: number; deadlineAt?: number }
  createdAt: number
  updatedAt: number
  finalResult?: unknown
}
```

### Resume policy

On pause/kill of the **run** (not individual node):

1. Re-execute script from top with same frozen script + args + `resultCache`.
2. `agent()` keys hit cache → return immediately.
3. Incomplete nodes re-run; nodes after an incomplete barrier may need re-run (Claude Code order rule — document clearly).
4. Prefer **small nodes** so stop mid fan-out wastes less work.

On **waiting_user**:

- Run stays `waiting_user` / `running` with parked promise.
- Other parallel nodes continue.
- Telegram answer unparks one node; no full script replay required.

---

## Operator UX (Telegram)

### Commands (sketch)

| Command | Effect |
|---|---|
| `/workflow` | List recent runs + saved scripts |
| `/workflow run <name> [args…]` | Approve + start |
| `/workflow status [runId]` | Phases, active nodes, budget |
| `/workflow pause` / `resume` | Soft pause / continue |
| `/workflow stop` | Kill run; keep cache for optional resume |
| `/workflow save <name>` | Persist last ad-hoc script to `.acpbot/workflows/` |
| `/linear drain` | Sugar → bundled `linear-drain` with binding as `args` |
| `/linear run` | Alias: parallel ready-set drain (same runtime) |

### Messages

| Event | Telegram |
|---|---|
| Pending approval | Phases summary + **View script** / **Run** / **Always allow this name** / **Deny** |
| Phase start | Optional one-liner (or digest every N min) |
| Node progress | Working bubble / `update` from child labeled `[slug]` |
| Permission | Existing parent-topic keyboard, labeled with child |
| Ask user | Existing `ask_user` / elicitation brokers; run parks that node |
| Node done | Short line: `✅ ENG-12 done` / `🚫 ENG-15 blocked: …` |
| Run complete | Final summary + Linear counts |

### Quiet mode

Config:

```toml
[workflows]
# enabled = true
# max_agents_per_run = 100
# max_concurrent = 4          # ≤ agents.spawn.max_concurrent_spawned
# require_approval = true
# digest_interval_sec = 300   # progress digest when quiet
# default_permission = "ask"  # overnight: operator chooses bypass carefully
```

---

## MCP tools (agent surface)

Host MCP server `acpbot`:

| Tool | Purpose |
|---|---|
| `workflow_list` | Saved scripts (project + user + bundled) + recent runs |
| `workflow_read` | Read script source (for edit) |
| `workflow_write` | Write/update project or ephemeral script (path rules) |
| `workflow_run` | Start run (`name` or inline path); returns `runId` |
| `workflow_wait` | Wait until run terminal or timeout; return summary |
| `workflow_status` | Structured progress |
| `workflow_kill` | Stop run |
| `workflow_save` | Promote ephemeral script to named project workflow |

**Agent authoring loop (skill):**

1. Operator: “background-drain this Linear project with verification.”
2. Agent writes `.acpbot/workflows/linear-drain.js` (or ephemeral).
3. `workflow_run` → host posts approval to Telegram (or auto if allowed).
4. Agent may `workflow_wait` or return; operator watches digests.
5. On success, suggest `workflow_save` if ephemeral.

Agents **must not** embed secrets in scripts. Linear OAuth stays on host MCP / existing proxy.

---

## Linear product shape (first bundled workflow)

### `/linear drain` — sequential or pipeline ready-set

1. Require topic binding (`linear_get_binding`).
2. List open issues (host helper or list agent).
3. Ready = open && no open blockers (Linear blocked-by).
4. `pipeline` or bounded `parallel` over ready set (caps).
5. Per issue: worktree child → implement → structured return.
6. Host: Linear comment + Done / leave blocked + comment.
7. Loop-until-dry optional (phase 2): re-list after batch; stop when K rounds add nothing or budget exhausted.
8. Final Telegram summary.

### vs existing commands

| Command | Orchestrator | Background |
|---|---|---|
| `/linear next` | One agent turn | No |
| `/linear fanout` | Parent agent MCP loop | Partial (children headless) |
| `/linear drain` | **Workflow runtime** | **Yes** |

Keep `/linear next` for interactive single-issue. Fanout can later **compile** to a generated workflow instead of a chatty parent.

### Optional diamond per issue (phase 2)

```text
issue → implement (grok-build, worktree) → verify (claude) → host.linearApply
```

`pipeline(issue, implementStage, verifyStage)` with schema gates on Done.

---

## Security & sandbox

| Risk | Mitigation |
|---|---|
| Script escapes sandbox | Isolated VM / restricted Bun context; no Node builtins except injects |
| Path write escape | `workflow_write` only under `.acpbot/workflows/` or run dir; no `..` |
| Runaway agents | `max_agents_per_run`, concurrency, wall deadline, existing spawn caps |
| Overnight destructive edits | Default `permission_mode=ask`; bypass only explicit config / approval |
| Prompt injection via Linear body | Treat issue body as untrusted data inside agent prompt; schema-limit tools |
| Symlink save attacks | Refuse writing through symlinks (Claude Code lesson) |

Scripts are **code execution** on the host machine. Ship disabled until `[workflows].enabled = true` and document risk next to multi-agent.

---

## Architecture (modules)

```text
src/workflows/
  types.ts              WorkflowRun, meta parse
  store.ts              durable runs under $state_dir
  script-load.ts        load + static meta extract + path allowlist
  sandbox.ts            execute script with injected API
  runtime.ts            agent/parallel/pipeline/budget implementation
  linear-helpers.ts     optional host.linear*
  bundled/
    linear-drain.js
    deep-audit.js       optional later

src/acp-host/
  workflow-runner.ts    tick / event drive active runs
  (scheduler.ts)        schedule fire → workflow_run envelope

src/mcp/server.ts       workflow_* tools
src/core/commands.ts    /workflow*, /linear drain
src/core/daemon.ts      Telegram progress + approval keyboards

skills/workflows/SKILL.md
test/workflows-*.test.ts
```

### Process placement

- **Runner on acp-host** — same reason agents live there: worker can die; runs continue.
- Worker delivers Telegram; host pushes progress via existing worker-api or host→worker channel (mirror schedule fire notifications).

---

## Phases

| Phase | Deliverable | Size (rough) |
|---|---|---|
| **0** | This design + skill stub + config flags (no runtime) | 0.5 d |
| **1** | Sandbox + `agent`/`parallel`/`pipeline` + durable run + MCP run/wait/status/kill | 5–8 d |
| **2** | Telegram approve / progress / pause / `waiting_user` integration | 3–5 d |
| **3** | Bundled `linear-drain` + `/linear drain` + `host.linearApplyResults` | 3–4 d |
| **4** | `workflow_write` / agent authoring skill + `workflow_save` | 2–3 d |
| **5** | Schedule → workflow fire; loop-until-dry; per-issue verify diamond | 3–5 d |
| **6** | Nested workflows, CLI, website docs page | 2–3 d |

**MVP that proves the product:** Phase 1–3. Agent-authored scripts (4) matter once the host graph is trustworthy.

---

## Failure modes

| Case | Behavior |
|---|---|
| Invalid meta / syntax | Fail before run; Telegram error |
| Schema mismatch | Retry agent up to N; then `null` or fail node (config) |
| Child spawn cap | Queue; do not exceed host caps |
| Child `waiting_user` forever | Digest reminder; optional auto-fail after TTL |
| Worker down mid-run | Host continues; Telegram catches up on reconnect |
| Host restart mid-run | Resume from `resultCache` + incomplete nodes |
| Script throw | Run `failed`; partial Linear updates kept; summary lists unfinished |
| Duplicate issue spawn | Node key / issue id lock in run state |

---

## Non-goals (v1)

- Full Claude Code compatibility / importing `.claude/workflows` unchanged  
- Sibling mesh between workflow children (parent hub only)  
- Arbitrary Node modules inside orchestrator  
- Multi-host workflow partition (all nodes on parent repo host)  
- Automatic PR merge  
- Replacing skills / multi-agent for small ad-hoc tasks  

---

## Config sketch

```toml
[workflows]
enabled = false
max_agents_per_run = 100
max_concurrent = 4
schema_retries = 2
require_approval = true
digest_interval_sec = 300
# project_dir relative to repo: .acpbot/workflows
# user_dir empty → $state_dir/workflows

[workflows.linear]
# bundled drain defaults
default_agent = "grok-build"
mark_done_on_success = true
respect_blockers = true
```

Hard ceiling: `max_concurrent` ≤ `[agents.spawn].max_concurrent_spawned`.

---

## Skill sketch (`skills/workflows/SKILL.md`)

Teach agents:

1. Prefer a **workflow** when: multi-stage, parallelizable, long-running, or repeatable overnight.
2. Prefer **single agent / multi-agent MCP** when: one-shot plan→impl in this topic.
3. Script rules: pure meta, schemas on edges, `budget.ok()` on loops, `.filter(Boolean)`, no secrets.
4. How to `workflow_write` → `workflow_run` → report `runId` to operator.
5. Linear: do not reimplement drain in chat if `/linear drain` or bundled script exists.

---

## Example prompts (operator)

```text
/linear drain
```

```text
Run a workflow: for every open issue in the bound Linear project that is unblocked,
implement it in a worktree, open a PR, and mark Done. Only ask me if blocked or ambiguous.
```

```text
ultracode-style: write a workflow that audits src/routes for missing auth,
adversarially verifies each finding, and returns a ranked list — then save it as audit-routes
```

(Natural language still goes through an agent that **authors** the script; the **run** is host-side.)

---

## Effort summary

| Slice | Estimate |
|---|---|
| Runtime MVP (1) | ~1–1.5 weeks |
| Telegram + Linear drain (2–3) | ~1–1.5 weeks |
| Authoring + schedules (4–5) | ~1 week |
| Docs / polish (6) | few days |

---

## Open decisions (remaining)

1. **Strong Linear REST helper** — Done/blocked without a close agent  
2. **Richer resume / `waiting_user` node parking** — park one leaf without stopping the graph  
3. **Structured return** — dedicated `workflow_return` MCP vs JSON fence parsing  
4. **Token accounting** — usage events vs agent-count budget only  

**Done:** host-process runner (orchestration on acp-host; worker proxies).

---

## Summary

- **Multi-agent spawn is the node.** **Workflows are the graph.**
- Agent-authored **JS scripts** under `.acpbot/workflows/` encode topology; **acp-host** runs them with zero orchestration tokens.
- **`agent` / `parallel` / `pipeline` / schema / budget`** mirror Claude Code; **`waiting_user` + Telegram** adapt the model to acpbot’s human channel.
- First product: **`/linear drain`** — background ready-set issue work with feedback and questions only.
- Ship behind `[workflows].enabled`, reuse spawn caps and Linear bindings, grow authoring after the host runtime is boringly reliable.
