---
name: eve
description: >
  EVE (Extraterrestrial Vegetation Evaluator) — background multi-agent
  directives. You author JS orchestration graphs; the host runs them with
  zero-token control flow; leaf agent() calls use worktrees. Prefer for
  Linear drains, multi-file audits, and long parallel jobs. Not ultracode.
  There are no shipped directive scripts — write one with eve_write, then
  eve_run (or inline source).
---

# EVE — author + run background directives

Named after WALL·E’s probe: **EVE runs the fleet while you wait for the plant.**

**You build the workflow.** acpbot does **not** ship named directives
(`linear-drain`, `audit-routes`, etc.). For any multi-step background job:

1. Design a small JS graph (discover → fan-out → synthesize)
2. Save it with **`eve_write`** (or pass **inline `source`** to `eve_run`)
3. Start it with **`eve_run`**
4. Tell the operator to **`/eve approve <runId>`** if the run is pending
5. **`eve_status`** for progress; summarize when complete

Never call this ultracode. Never reimplement long fan-out only in chat when
an EVE graph fits.

## Tools (host MCP `acpbot`)

| Tool | Purpose |
|---|---|
| `eve_list` | Project/user scripts + recent runs |
| `eve_write` | Save `<repo>/.acpbot/eve/<name>.js` (or user scope) |
| `eve_run` | Start by `name`, `path`, or inline `source` + optional `args` |
| `eve_approve` | Approve a pending run |
| `eve_status` / `eve_pause` / `eve_resume` / `eve_kill` | Control |

Operator: `/eve` (alias `/directive`). `/linear drain` kicks **you** to
author a drain directive for the bound project — it does not run a built-in.

## When to use EVE vs chat multi-agent

| Situation | Use |
|---|---|
| One implementer after a plan | `agent_spawn` (multi-agent skill) |
| One Linear issue interactively | `/linear next` or `/linear work` |
| Drain a Linear project unattended | **Write + `eve_run` a drain directive** |
| Multi-file audit / parallel graph | **Write + `eve_run`** |
| Recurring background job | Schedule whose fire prompt calls `eve_run` on a script you saved |

## Script shape (required)

Every script must export a **pure-literal** `meta` object, then a top-level
body that can use `await` (no `export default` required):

```js
export const meta = {
  name: 'my-job',           // [a-z0-9_-], max 64
  description: 'One line for operators',
  phases: [                 // optional; shown in /eve status
    { title: 'Discover' },
    { title: 'Work' },
    { title: 'Close' },
  ],
}

phase('Discover')
const found = await agent(
  'List the work items… Return JSON only.',
  {
    label: 'discover',
    schema: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
            },
          },
        },
      },
    },
  },
)

const items = (found && found.items) ? found.items : []
if (!items.length) {
  log('nothing to do')
  return { done: 0 }
}

phase('Work')
const results = await pipeline(items, (item) =>
  agent(
    `Do ONLY this item: ${item.id} — ${item.title}\nReport status + summary.`,
    {
      label: String(item.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24),
      phase: 'Work',
      role: 'implementer',
      schema: {
        type: 'object',
        required: ['status', 'summary'],
        properties: {
          status: { type: 'string', enum: ['done', 'blocked'] },
          summary: { type: 'string' },
          prUrl: { type: 'string' },
        },
      },
      timeout_sec: 1200,
    },
  ),
)

phase('Close')
const ok = (results || []).filter(Boolean)
log(`done=${ok.filter((r) => r.status === 'done').length} blocked=${ok.filter((r) => r.status === 'blocked').length}`)
return { results: ok }
```

Save + run:

```
eve_write({ name: "my-job", source: "<full script including meta>" })
eve_run({ name: "my-job", args: { /* optional */ } })
// or one-shot: eve_run({ source: "<full script>", args: { … } })
```

Paths: project `.acpbot/eve/<name>.js`, or user `$state_dir/eve/directives/`.

## Injected API (orchestrator only)

| Name | Role |
|---|---|
| `agent(prompt, opts?)` | Spawn a leaf ACP worker; returns parsed JSON, a **soft partial** object, or **`null` on hard failure** |
| `parallel([() => …, …])` | Run thunks concurrently (respects `max_concurrent`) |
| `pipeline(items, …stages)` | For each item, run stage functions left→right; collect results |
| `phase(title)` | Mark active phase (status UI) |
| `log(msg)` | Append to run log (operator-visible digests) |
| `args` | Object from `eve_run({ args })` |
| `budget` | `{ agentsMax, agentsUsed(), remainingAgents(), ok(), deadlineAt? }` |
| `host` | Host helpers (see below) |
| `workflow(name, args?)` | Nested named directive (project/user scripts only) |

### `agent(prompt, options?)`

| Option | Notes |
|---|---|
| `schema` | JSON Schema for the return value — **always prefer this** |
| `label` | Short id for digests + resume cache (stable per logical node) |
| `phase` | Override active phase for this leaf |
| `agent` / `model` | Leaf agent id (default from `[eve].default_agent`) |
| `role` | Spawn role string (e.g. `implementer`) |
| `timeout_sec` | Default ~900 |
| `isolation` | Declared preference; host typically uses a **git worktree** per leaf when possible |

Orchestrator has **no `fs` / network / shell**. Only leaf agents touch the world.

### Leaf handoff (how results come back)

1. Host runs the leaf, collects **assistant output text** (not thought stream).
2. Parses JSON (prefer a final ` ```json ` fence).
3. Validates `schema` when set; retries (`schema_retries`) with a fix-up prompt.
4. If the leaf **completed** but JSON still fails schema, the host may **soft-fill**
   a partial object (`status: "partial"`, `summary`, `issueId` from `label` when
   that matches the schema) so sequential drains don’t get false `null`s for
   successful work. Hard failures stay `null`.

**Leaf prompt tip:** after commit/push, always **print the schema JSON** as the
last assistant message. Tools-only finishes used to look like “null failure”
even when git work was fine.

Telegram digests: ✅ valid · ⚠️ soft partial · 🚫 failed.

## Hard rules

1. **Schemas on every structured edge** — discover lists, per-item results, final merge
2. **Failed / missing leaves are falsy** — always `.filter(Boolean)`; treat `status === "partial"` as “work maybe done, handoff weak”
3. **Guard loops** with `if (!budget.ok()) break` (and cap fan-out size)
4. **One logical task per leaf** — don’t ask one agent to do five issues
5. **No secrets** in scripts or prompts (tokens live in host OAuth / config)
6. **Idempotent labels** — same `label`+`phase` can resume from cache after pause; labels like `pas-134` help soft `issueId`
7. Prefer **`pipeline`** for “map over list”; **`parallel`** for fixed independent stages
8. Keep prompts **self-contained** — leaf sees only its prompt, not chat history

## Recipe patterns (build these yourself)

### A. Linear project drain (ready-set)

When the operator wants an unattended drain (`/linear drain`, “drain the
project”, “work open issues in background”):

1. `linear_get_binding` — require a bound project; stop if missing
2. `eve_write` a directive named e.g. `linear-drain` (project scope) that:
   - **Discover:** one `agent()` with Linear MCP instructions: list open
     issues in the **bound** project only; return `{ issues: [{ id,
     identifier, title, body, blockedBy[] }] }` via schema
   - Filter to **ready** (empty `blockedBy`), cap with `args.maxIssues` (default 20)
   - **Implement:** `pipeline(ready, issue => agent(…only this issue…, {
     label: identifier, schema: { status: done|blocked, summary, prUrl? },
     timeout_sec: 1200 }))`
   - **Close:** either call `host.linearApplyResults(results)` if present, or
     one final `agent()` that comments + sets Done/blocked from the JSON
3. `eve_run({ name: "linear-drain", args: { maxIssues?, sequential? } })`
4. Tell operator: approve if pending; watch `/eve status`

Pass binding ids in `args` when useful (`projectId`, `projectName`). Leaf
prompts must still say “bound project only”.

### B. Fan-out audit / review

Discover paths → `pipeline` per file/module → synthesize ranked findings.
Use tight schemas (`issues: [{ title, severity, detail }]`). Cap list size.

### C. Plan → implement → verify diamond

```js
phase('Plan')
const plan = await agent('…', { label: 'plan', schema: PlanSchema })
phase('Implement')
const impl = await agent(`Implement:\n${JSON.stringify(plan)}`, {
  label: 'impl', role: 'implementer', schema: ImplSchema, timeout_sec: 1800,
})
phase('Verify')
const review = await agent(`Review this work:\n${JSON.stringify(impl)}`, {
  label: 'review', role: 'reviewer', schema: ReviewSchema,
})
return { plan, impl, review }
```

## Operator / approval

- Default: runs start as **`pending_approval`** until `/eve approve <runId>` or `eve_approve`
- Config: `[eve] require_approval = false` skips that gate
- Orchestration runs on **acp-host** (survives worker restart); digests hit Telegram via the worker

## Config (operator TOML)

```toml
[eve]
enabled = true
max_agents_per_run = 100
max_concurrent = 4
schema_retries = 2
require_approval = true
default_agent = "grok-build"
```

Hard spawn caps from `[agents.spawn]` still apply. Leaves free slots after each node finishes.

## Do not

- Expect built-in names (`linear-drain`, `audit-routes`) to exist until **you** write them
- Put long multi-issue loops only in chat when EVE fits
- Ignore `budget.ok()` or spawn caps
- Call it ultracode
- Commit secrets into `.acpbot/eve/*.js`
