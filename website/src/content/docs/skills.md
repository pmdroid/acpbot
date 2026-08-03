---
title: Skills
description: Bundled telegram + schedules skills and global install.
order: 15
section: reference
---

acpbot ships two **operator skills** for coding agents (Grok, Claude, Codex, …):

| Skill | Package path | Purpose |
|---|---|---|
| **telegram** | [`skills/telegram/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/telegram/SKILL.md) | Progress pings, mid-turn text, photos, files, voice via host MCP `acpbot` |
| **schedules** | [`skills/schedules/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/schedules/SKILL.md) | Create / list / cancel / fire delayed or recurring jobs |

The package tree is the source of truth; install puts them in global agent skill dirs so every workspace sees them.

## Install (onboarding)

```bash
bun run skills:install
```

Run after clone or skill upgrades. The **worker does not** install skills on boot.

Install targets (symlink preferred, copy fallback). Never overwrites a real directory that is not already an acpbot skill symlink:

- `~/.agents/skills/{telegram,schedules}`
- `~/.grok/skills/{telegram,schedules}`
- `~/.claude/skills/{telegram,schedules}`

## Discovery

| Path | Who uses it |
|---|---|
| Package `skills/` | Always on `skillRoots` for Telegram `/skills` |
| `~/.agents/skills`, `~/.grok/skills`, `~/.claude/skills` | Global agent CLIs after install |
| Session cwd `.agents/skills` (etc.) | Per-repo overrides |

Extra roots: `[skills].roots` in `config.toml`, or env `ACPBOT_SKILL_ROOTS` (colon / semicolon / comma separated). See [Configuration](/docs/configuration).

## Telegram `/skills`

In a topic, `/skills` lists skills from config roots + session cwd, then composes a prompt for the agent with the chosen skill body.

## Related

- [MCP](/docs/mcp) — host tools those skills describe  
- [Schedules](/docs/schedules) — how host fire works  
- [Worker API](/docs/worker-api) — how outbound Telegram is delivered
