---
name: schedule
description: When the user wants recurring or delayed work in this repo (reminders, briefs, backups), create a durable job via tacp schedule_* MCP tools.
---

# Schedule jobs (tacp)

You are in a **tacp** topic session. Schedules live **in this repo** at
`.tacp/schedules/<id>.json` (prompt is stored on disk; optional script path).

## When to schedule

- Recurring work (morning brief, weekday checks, nightly backup oversight).
- One-shot delayed work (“in 2 hours”, “Monday 9am”).
- Prefer a schedule over asking the user to re-prompt later.

Do **not** schedule every small follow-up; use when durability across restarts matters.

## Tools (host MCP `tacp`)

```
schedule_create({
  name?: "weekday-morning-brief",
  prompt: "Full instruction for the agent at fire time…",  // required
  script?: ".tacp/schedules/scripts/morning.sh",           // optional, in-repo only
  kind: "once" | "cron",
  runAt?: "2026-08-04T08:00:00.000Z",   // once
  cronExpr?: "0 8 * * 1-5",             // cron, 5-field UTC
  timezone?: "UTC"
})

schedule_list({ all?: false })   // default: this session only
schedule_cancel({ id: "…" })     // soft-disable (enabled: false)
```

## Rules

- **`prompt` is always required** — what to do when the job fires.
- **`script` is optional** — relative path only; never `..` outside the repo.
- Prefer scripts under `.tacp/schedules/scripts/`.
- Cancel keeps the file for git history; it does not delete.
- Host auto-fire may be separate; creating the job is still useful (durable intent).

## Do not

- Put secrets in the prompt or committed script if the repo is shared.
- Use absolute script paths or path escapes.
- Invent fire times without `runAt` / `cronExpr` matching `kind`.
