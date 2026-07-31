# In-repo schedules

Agents can create **durable jobs** as JSON files under the session repo. The long-lived **acp-host** process fires due jobs into the right session slots — even if the Telegram worker is down.

## Storage

```text
<repo>/.tacp/schedules/<id>.json
```

Optional scripts (relative to repo root):

```text
.tacp/schedules/scripts/<name>
```

## MCP tools (server `tacp`)

| Tool | Action |
|---|---|
| `schedule_create` | `prompt` (required) + optional `script` path + `once` / `cron` |
| `schedule_list` | Jobs for `TACP_SESSION_KEY` (or whole repo with `all: true`) |
| `schedule_cancel` | Soft-disable for **this session** (`enabled: false`); `all: true` for any in-repo job |
| `schedule_run_now` | Set `nextRunAt=now` so the host fires on the next tick |

`script` must be **relative to the repo root** (no `..` escapes). Prefer `.tacp/schedules/scripts/<name>`.

## Cron

- 5-field cron: `m h dom mon dow`
- **Next-run is computed in UTC** for MVP
- The `timezone` field is stored (non-UTC values may warn on create) but does **not** shift the schedule yet
- When both day-of-month and day-of-week are restricted, classic cron **OR** applies (either may match)

## Host fire (`bun run acp-host`)

Requirements:

- `TACP_REPOS_JSON` maps catalog keys → absolute repo paths
- Optional `TACP_SCHEDULE_TICK_MS` (default `20000`)

Each tick:

1. Scan each catalog repo’s `.tacp/schedules/`
2. Collect jobs with `enabled && nextRunAt <= now`
3. **Claim on disk before** the agent turn:
   - `once` → `enabled: false`
   - `cron` → advance `nextRunAt` from now
4. Ensure the job’s `sessionKey` slot and prompt with an envelope (prompt + optional script path)

| Outcome | Behavior |
|---|---|
| Success | Claim retained; cron already advanced |
| Slot busy | Claim rolled back, `lastStatus: busy`, retry next tick |
| Fire error | Claim left in place (no hot-loop); re-due once jobs via `schedule_run_now` |

Works without the Telegram worker (create/list/cancel only need MCP). Firing needs **acp-host**. Delivering Telegram photos/files from a fire needs the **worker** (worker API).

Agent skill: package [`skills/schedules`](../skills/schedules/SKILL.md) — install with `bun run skills:install` (see [skills.md](skills.md)).

## Implementation map

| Area | Path |
|---|---|
| Store / types | `src/schedules/` |
| Host ticker | `src/acp-host/scheduler.ts` |
| MCP tools | `src/mcp/server.ts` (built-in `tacp`) |
| Agent skill | `skills/schedules/` |
| Tests | `test/host-scheduler.test.ts`, `test/schedules-store.test.ts` |
