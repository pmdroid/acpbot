---
name: memory
description: >
  Durable session/repo memory via acpbot MCP tools (memory_read / memory_write /
  memory_status). Use whenever facts should survive the next session or compact,
  or before acting on standing preferences and open loops. Files live in the git repo.
---

# Memory (acpbot)

Host MCP server: **`acpbot`**. Prefer these tools over raw file writes to random paths.

## Layout (always under the **repo root**)

| section | File | Use for |
|---|---|---|
| `memory` | `MEMORY.md` | Curated long-term facts & decisions (keep short) |
| `user` | `USER.md` | Operator preferences / profile |
| `daily` | `memory/YYYY-MM-DD.md` | Episodic notes, session summaries (default: today UTC) |
| `session` | `memory/sessions/<slug>.md` | Optional topic-specific working notes |

## Tools

```
memory_status({})
memory_read({ section: "memory" | "user" | "daily" | "session", date?: "YYYY-MM-DD" })
memory_write({
  section: "memory" | "user" | "daily" | "session",
  content: "markdown…",
  mode?: "append" | "replace",   // default append
  date?: "YYYY-MM-DD",           // daily only
  heading?: "optional append heading"
})
```

## Habits (required)

| Do | Don't |
|----|--------|
| **`memory_write`** when something should survive compact / next day | Rely on chat history alone |
| **`memory_read`** before acting on prefs, people, open loops | Invent paths outside the layout |
| Append daily notes; keep MEMORY.md curated | Dump full transcripts into MEMORY.md |
| Use tools (`memory_*`) | Write only under a disposable worktree |

## Operator `/compact`

`/compact` or `/compact <focus>` asks you to flush via **these same tools**, then summarize.

## Examples

```
memory_read({ section: "memory" })
memory_write({ section: "daily", content: "- Agreed to ship headless multi-agent default" })
memory_write({ section: "user", content: "- Prefer short Telegram updates", mode: "append" })
```
