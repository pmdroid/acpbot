/**
 * Embedded operator skills shipped inside the acpbot binary.
 * Keep in sync with package `skills/{telegram,schedules,multi-agent,linear,eve}/SKILL.md`.
 *
 * Binary installs materialize these under ~/.local/share/acpbot/bundled-skills/
 * via `acpbot skills install` (and on demand for skillRoots discovery).
 */

export type BundledSkillFiles = Record<string, string>;

/** skill id → relative path → file body */
export const BUNDLED_SKILLS: Record<string, BundledSkillFiles> = {
  telegram: {
    "SKILL.md": `---
name: telegram
description: >
  Operator messaging on acpbot (Telegram topics): progress updates, mid-turn text,
  photos, files, and voice. Use whenever you need to reach the human on Telegram
  beyond the final reply — status pings, attachments, or spoken notes.
---

# Telegram (acpbot)

You are in an **acpbot** Telegram topic. The operator only sees what you send on Telegram
(normal reply text, plus the tools below). They do not see your thinking.

Host MCP server: **\`acpbot\`**. Call tools by name (clients may show them as \`acpbot__…\` or \`acpbot__…\`).

## Keep the operator updated (required habit)

While a turn is still running, the topic shows one **⏳ Working…** bubble.  
**You must keep it useful** on multi-step work:

\`\`\`
update({ text: "Migrated schema; running tests next…" })
\`\`\`

| Do | Don't |
|----|--------|
| Call **\`update\`** after major steps, long waits, or plan changes | Leave "Working…" frozen for minutes with no change |
| Lead with what finished / what you're doing next | Dump the final answer into \`update\` |
| Prefer 1–3 short sentences | Spam on every tiny tool call |

The host **deletes** the bubble when your final reply lands. Final answers stay in your **normal assistant message**.

If work will take a while, **call \`update\` early and often enough that a human watching the topic knows you're alive.**

## Tool map

| Tool | When |
|------|------|
| **\`update\`** | **Default progress channel** — edit the live working bubble (not spam) |
| **\`telegram_send\`** | Mid-turn text that is not a status ping (link, note, intermediate result) |
| **\`telegram_send_photo\`** | Image the operator should see (screenshot, plot, generated picture) |
| **\`telegram_send_file\`** | Non-image file (log, PDF, patch, archive) |
| **\`speak\`** | Voice note when they asked for spoken/TTS, or a short audible confirm |

## Operator queue vs steer (for your awareness)

- Free-text the operator sends **while you are mid-turn** is **queued** and only starts a **new turn after you finish** (does not interrupt you).
- **\`/steer …\`** **interrupts** your current turn and injects guidance immediately as a new turn.
- Prefer **\`update\`** so they don't need to spam or steer for status alone.

## Text

\`\`\`
update({ text: "Migrated schema; running tests…" })
telegram_send({ text: "Preview: https://…" })
\`\`\`

- **\`update\`**: progress only; edits the single working bubble.
- **\`telegram_send\`**: permanent mid-turn messages (links, intermediate results).
- Do **not** use either for the final answer (use the normal reply).

## Photos and files

\`\`\`
telegram_send_photo({ path: "images/out.png", caption?: "…" })
telegram_send_file({ path: "dist/report.pdf", caption?: "…", filename?: "report.pdf" })
\`\`\`

- Paths must be **inside the session repo** (relative to repo root, or absolute under it).
- Prefer **photo** for images meant to view inline; **file** for everything else.
- Limits are roughly photo ~10MB, file ~50MB.
- If the file lives only under the agent session folder, **copy it into the repo first**, then send.

## Voice

\`\`\`
speak({ text: "Short natural line for the voice note." })
\`\`\`

- Only when the user wants voice/spoken/TTS, or a brief audible confirm is clearly better.
- Keep text concise and speakable (no markdown walls).
- Still send readable text when they need to read something.
- Do **not** call \`speak\` on every message.

## Worker requirement

Outbound tools need the **acpbot worker** running (Telegram bot + worker API).
If a tool says the worker API is unreachable, tell the operator the worker is down;
do not invent a fake "sent" status.

## Related

For delayed or recurring work, use the **schedules** skill (\`schedule_create\` / \`list\` / \`cancel\` / \`run_now\`).
`,
  },
  schedules: {
    "SKILL.md": `---
name: schedules
description: >
  Create, list, cancel, or fire delayed/recurring work for this acpbot session
  (reminders, briefs, follow-ups). Use when the operator wants something later
  or on a cron, not for every small follow-up.
---

# Schedules (acpbot)

Schedule durable work for this topic session via host MCP server **\`acpbot\`**.

## When

- One-shot later: "in 5 minutes", "Monday 9:00 UTC"
- Recurring: weekday morning brief, nightly check
- Prefer a schedule over asking the human to re-prompt later

Do **not** schedule every small next step.

## Tools

\`\`\`
schedule_create({
  name?: "goldy-beach-picture",
  prompt: "Full instruction for the agent when this fires…",  // required
  script?: "scripts/optional.sh",                             // optional, in-repo only
  kind: "once" | "cron",
  runAt?: "2026-08-04T08:00:00.000Z",                         // once (ISO)
  cronExpr?: "0 8 * * 1-5",                                   // cron, 5-field UTC
  timezone?: "UTC"
})

schedule_list({ all?: false })     // this session; all=true → whole repo
schedule_cancel({ id: "…", all?: false })
schedule_run_now({ id: "…", all?: false })  // due on next host tick
\`\`\`

## Rules

- **\`prompt\` is always required** — what to do at fire time (be concrete).
- **\`once\`** needs \`runAt\`; **\`cron\`** needs \`cronExpr\` (UTC).
- **\`script\`** is optional and must stay inside the session repo.
- Cancel **disables** the job; it does not delete it.
- Default scope is **this session**; use \`all: true\` only when needed.
- Firing needs **acp-host** running; create still saves the job if the host is down.

## Prompt tips

Write the fire prompt so a cold turn can succeed alone, e.g. generate asset → save under
repo → send via \`telegram_send_photo\` / \`telegram_send_file\` if the operator should see it.

For **background multi-agent work**, prefer EVE (see **eve** skill): ensure a project
script exists under \`.acpbot/eve/\` (\`eve_write\` if needed), then \`eve_run({ name: "…" })\` —
no built-in directive names.

## Do not

- Put secrets in prompts or committed scripts.
- Use path escapes or absolute paths outside the repo.
- Assume non-UTC \`timezone\` shifts the clock (firing is UTC for now).
`,
  },
  "multi-agent": {
    "SKILL.md": `---
name: multi-agent
description: >
  Spawn parent-linked child ACP agents via host MCP tools (agent_spawn / list /
  send / wait / kill). Each child runs in a new git worktree. Use after a plan
  to fan out implementers; parent is the A2A hub.
---

# Multi-agent spawn (acpbot MCP)

Host MCP server: **\`acpbot\`**. Tools (no CLI in v1):

| Tool | Purpose |
|---|---|
| \`agent_spawn\` | Create child + **new git worktree** + optional kickoff (\`headless\` default true — permissions on parent topic) |
| \`agent_list\` | List children of **this** session |
| \`agent_send\` | Message a child (slug) or \`parent\` |
| \`agent_wait\` | Wait until child idle/done/failed (returns summary) |
| \`agent_kill\` | Soft-close (\`dispose:false\`) or hard remove (\`dispose:true\`); worktree kept unless \`remove_worktree:true\` |

## Rules

- Parent cwd is never shared — every child has its own branch under \`$state_dir/worktrees/…\`
- Parent hub only: no sibling-to-sibling mesh
- Caps: depth and max children (config \`[agents.spawn]\`)
- Parent must be a **git** work tree or spawn fails
- Do not put secrets in A2A messages

## Plan → implement recipe

1. Finish the plan with the operator in this topic
2. \`agent_spawn({ name: "impl", agent: "codex", prompt: "…" })\`
3. \`agent_wait({ to: "impl" })\`
4. Optionally spawn a reviewer; or merge/PR from the child branch
5. Summarize to the operator

## Linear project fan-out

When this topic is bound to a Linear project (see **linear** skill / \`/linear fanout\`):

1. List open issues in the bound project only
2. Confirm spawn plan with the operator
3. One \`agent_spawn\` per issue (slug from issue id); kickoff = issue body + acceptance criteria
4. Parent waits; on success update Linear (comment + Done)
5. Do not share parent cwd; respect spawn caps
`,
  },
  linear: {
    "SKILL.md": `---
name: linear
description: >
  Linear via acpbot: OAuth MCP tools for issues/projects, plus host binding so
  this Telegram topic is tied to one Linear project. Use when exporting a plan
  to Linear, working the bound project's backlog, fan-out, or updating issue status.
---

# Linear (acpbot)

This topic can be **bound** to one Linear project. That project is the backlog
you work through. Free-text turns may include a sticky \`[Linear] Bound project …\`
prefix when bound — honor it.

## Setup (operator)

1. \`[oauth].callback_base\` configured (\`acpbot setup\`)
2. \`/linear connect\` — official MCP + OAuth
3. \`/linear project <id|url>\` or export + \`linear_bind_project\`

## Host tools

\`linear_get_binding\` · \`linear_bind_project\` (set \`lastIssueId\`) · \`linear_unbind_project\`

## Rules

- Scope to bound project only
- **One issue per turn** unless \`/linear fanout\` or EVE drain
- In Progress → implement → comment → Done (or blocked)
- Prefer Linear MCP over shell/curl
- \`/linear drain\` → **author + run** an EVE directive (see **eve** skill; no built-in script)

## Operator commands

\`/linear\` · \`connect\` · \`project\` · \`export\` · \`next\` · \`work\` · \`fanout\` · \`drain\` · \`unbind\`
`,
  },
  eve: {
    "SKILL.md": `---
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
(\`linear-drain\`, \`audit-routes\`, etc.). For any multi-step background job:

1. Design a small JS graph (discover → fan-out → synthesize)
2. Save it with **\`eve_write\`** (or pass **inline \`source\`** to \`eve_run\`)
3. Start it with **\`eve_run\`**
4. Tell the operator to **\`/eve approve <runId>\`** if the run is pending
5. **\`eve_status\`** for progress; summarize when complete

Never call this ultracode. Never reimplement long fan-out only in chat when
an EVE graph fits.

## Tools (host MCP \`acpbot\`)

| Tool | Purpose |
|---|---|
| \`eve_list\` | Project/user scripts + recent runs |
| \`eve_write\` | Save \`<repo>/.acpbot/eve/<name>.js\` (or user scope) |
| \`eve_run\` | Start by \`name\`, \`path\`, or inline \`source\` + optional \`args\` |
| \`eve_approve\` | Approve a pending run |
| \`eve_status\` / \`eve_pause\` / \`eve_resume\` / \`eve_kill\` | Control |

Operator: \`/eve\` (alias \`/directive\`). \`/linear drain\` kicks **you** to
author a drain directive for the bound project — it does not run a built-in.

## When to use EVE vs chat multi-agent

| Situation | Use |
|---|---|
| One implementer after a plan | \`agent_spawn\` (multi-agent skill) |
| One Linear issue interactively | \`/linear next\` or \`/linear work\` |
| Drain a Linear project unattended | **Write + \`eve_run\` a drain directive** |
| Multi-file audit / parallel graph | **Write + \`eve_run\`** |
| Recurring background job | Schedule whose fire prompt calls \`eve_run\` on a script you saved |

## Script shape (required)

Every script must export a **pure-literal** \`meta\` object, then a top-level
body that can use \`await\` (no \`export default\` required):

\`\`\`js
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
    \`Do ONLY this item: \${item.id} — \${item.title}\\nReport status + summary.\`,
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
log(\`done=\${ok.filter((r) => r.status === 'done').length} blocked=\${ok.filter((r) => r.status === 'blocked').length}\`)
return { results: ok }
\`\`\`

Save + run:

\`\`\`
eve_write({ name: "my-job", source: "<full script including meta>" })
eve_run({ name: "my-job", args: { /* optional */ } })
// or one-shot: eve_run({ source: "<full script>", args: { … } })
\`\`\`

Paths: project \`.acpbot/eve/<name>.js\`, or user \`$state_dir/eve/directives/\`.

## Injected API (orchestrator only)

| Name | Role |
|---|---|
| \`agent(prompt, opts?)\` | Spawn a leaf ACP worker; returns parsed JSON or **\`null\` on failure** |
| \`parallel([() => …, …])\` | Run thunks concurrently (respects \`max_concurrent\`) |
| \`pipeline(items, …stages)\` | For each item, run stage functions left→right; collect results |
| \`phase(title)\` | Mark active phase (status UI) |
| \`log(msg)\` | Append to run log (operator-visible digests) |
| \`args\` | Object from \`eve_run({ args })\` |
| \`budget\` | \`{ agentsMax, agentsUsed(), remainingAgents(), ok(), deadlineAt? }\` |
| \`host\` | Host helpers (see below) |
| \`workflow(name, args?)\` | Nested named directive (project/user scripts only) |

### \`agent(prompt, options?)\`

| Option | Notes |
|---|---|
| \`schema\` | JSON Schema for the return value — **always prefer this** |
| \`label\` | Short id for digests + resume cache (stable per logical node) |
| \`phase\` | Override active phase for this leaf |
| \`agent\` / \`model\` | Leaf agent id (default from \`[eve].default_agent\`) |
| \`role\` | Spawn role string (e.g. \`implementer\`) |
| \`timeout_sec\` | Default ~900 |
| \`isolation\` | Declared preference; host typically uses a **git worktree** per leaf when possible |

Orchestrator has **no \`fs\` / network / shell**. Only leaf agents touch the world.

## Hard rules

1. **Schemas on every structured edge** — discover lists, per-item results, final merge
2. **Failed leaves are \`null\`** — always \`.filter(Boolean)\` before counting
3. **Guard loops** with \`if (!budget.ok()) break\` (and cap fan-out size)
4. **One logical task per leaf** — don’t ask one agent to do five issues
5. **No secrets** in scripts or prompts (tokens live in host OAuth / config)
6. **Idempotent labels** — same \`label\`+\`phase\` can resume from cache after pause
7. Prefer **\`pipeline\`** for “map over list”; **\`parallel\`** for fixed independent stages
8. Keep prompts **self-contained** — leaf sees only its prompt, not chat history

## Recipe patterns (build these yourself)

### A. Linear project drain (ready-set)

When the operator wants an unattended drain (\`/linear drain\`, “drain the
project”, “work open issues in background”):

1. \`linear_get_binding\` — require a bound project; stop if missing
2. \`eve_write\` a directive named e.g. \`linear-drain\` (project scope) that:
   - **Discover:** one \`agent()\` with Linear MCP instructions: list open
     issues in the **bound** project only; return \`{ issues: [{ id,
     identifier, title, body, blockedBy[] }] }\` via schema
   - Filter to **ready** (empty \`blockedBy\`), cap with \`args.maxIssues\` (default 20)
   - **Implement:** \`pipeline(ready, issue => agent(…only this issue…, {
     label: identifier, schema: { status: done|blocked, summary, prUrl? },
     timeout_sec: 1200 }))\`
   - **Close:** either call \`host.linearApplyResults(results)\` if present, or
     one final \`agent()\` that comments + sets Done/blocked from the JSON
3. \`eve_run({ name: "linear-drain", args: { maxIssues?, sequential? } })\`
4. Tell operator: approve if pending; watch \`/eve status\`

Pass binding ids in \`args\` when useful (\`projectId\`, \`projectName\`). Leaf
prompts must still say “bound project only”.

### B. Fan-out audit / review

Discover paths → \`pipeline\` per file/module → synthesize ranked findings.
Use tight schemas (\`issues: [{ title, severity, detail }]\`). Cap list size.

### C. Plan → implement → verify diamond

\`\`\`js
phase('Plan')
const plan = await agent('…', { label: 'plan', schema: PlanSchema })
phase('Implement')
const impl = await agent(\`Implement:\\n\${JSON.stringify(plan)}\`, {
  label: 'impl', role: 'implementer', schema: ImplSchema, timeout_sec: 1800,
})
phase('Verify')
const review = await agent(\`Review this work:\\n\${JSON.stringify(impl)}\`, {
  label: 'review', role: 'reviewer', schema: ReviewSchema,
})
return { plan, impl, review }
\`\`\`

## Operator / approval

- Default: runs start as **\`pending_approval\`** until \`/eve approve <runId>\` or \`eve_approve\`
- Config: \`[eve] require_approval = false\` skips that gate
- Orchestration runs on **acp-host** (survives worker restart); digests hit Telegram via the worker

## Config (operator TOML)

\`\`\`toml
[eve]
enabled = true
max_agents_per_run = 100
max_concurrent = 4
schema_retries = 2
require_approval = true
default_agent = "grok-build"
\`\`\`

Hard spawn caps from \`[agents.spawn]\` still apply. Leaves free slots after each node finishes.

## Do not

- Expect built-in names (\`linear-drain\`, \`audit-routes\`) to exist until **you** write them
- Put long multi-issue loops only in chat when EVE fits
- Ignore \`budget.ok()\` or spawn caps
- Call it ultracode
- Commit secrets into \`.acpbot/eve/*.js\`
`,
  }
};

export const BUNDLED_SKILL_IDS = Object.keys(BUNDLED_SKILLS);
