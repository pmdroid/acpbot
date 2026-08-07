---
name: schedules
description: >
  Create, list, cancel, or fire delayed/recurring work for this acpbot session
  (reminders, briefs, follow-ups). Use when the operator wants something later
  or on a cron, not for every small follow-up.
---

# Schedules (acpbot)

Schedule durable work for this topic session via host MCP server **`acpbot`**.

## When

- One-shot later: “in 5 minutes”, “Monday 9:00 UTC”
- Recurring: weekday morning brief, nightly check
- Prefer a schedule over asking the human to re-prompt later

Do **not** schedule every small next step.

## Tools

```
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
```

## Rules

- **`prompt` is always required** — what to do at fire time (be concrete).
- **`once`** needs `runAt`; **`cron`** needs `cronExpr` (UTC).
- **`script`** is optional and must stay inside the session repo.
- Cancel **disables** the job; it does not delete it.
- Default scope is **this session**; use `all: true` only when needed.
- Firing needs **acp-host** running; create still saves the job if the host is down.

## Prompt tips

Write the fire prompt so a cold turn can succeed alone, e.g. generate asset → save under
repo → send via `telegram_send_photo` / `telegram_send_file` if the operator should see it.

For **background multi-agent work**, prefer an **EVE** directive at fire time (see
**eve** skill): ensure a project script exists under `.acpbot/eve/` (author with
`eve_write` if needed), then `eve_run({ name: "…" })` — do not assume any built-in
directive names exist.

## Do not

- Put secrets in prompts or committed scripts.
- Use path escapes or absolute paths outside the repo.
- Assume non-UTC `timezone` shifts the clock (firing is UTC for now).
