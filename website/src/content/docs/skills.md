---
title: Skills
description: Bundled telegram, schedules, multi-agent, autoreview, linear, eve, computer skills and global install.
order: 15
section: reference
---

acpbot ships **operator skills** for coding agents (Grok, Claude, Codex, …):

| Skill | Package path | Purpose |
|---|---|---|
| **telegram** | [`skills/telegram/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/telegram/SKILL.md) | Progress pings, mid-turn text, photos, files, voice via host MCP `acpbot` |
| **schedules** | [`skills/schedules/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/schedules/SKILL.md) | Create / list / cancel / fire delayed or recurring jobs |
| **multi-agent** | [`skills/multi-agent/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/multi-agent/SKILL.md) | Spawn parent-linked children (`agent_*` tools, worktrees) — [Multi-agent](/docs/multi-agent) |
| **autoreview** | [`skills/autoreview/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/autoreview/SKILL.md) | Dual-agent closeout review (`/review`, `review_run`) — [Review](/docs/review) |
| **linear** | [`skills/linear/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/linear/SKILL.md) | Linear MCP + topic↔project binding — [Linear](/docs/linear) |
| **eve** | [`skills/eve/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/eve/SKILL.md) | Background multi-agent directives (JS graphs) — [EVE](/docs/eve) |
| **computer** | [`skills/computer/SKILL.md`](https://github.com/pmdroid/acpbot/blob/main/skills/computer/SKILL.md) | Isolated Playwright browser (`computer_*`; `/computer on`) — [Commands](/docs/commands#computer-isolated-browser) |

Skills are **embedded in the release binary**. Telegram **`/skills`** discovers them automatically. Install globally so agent CLIs also see them in every workspace.

Durable session memory is left to each coding agent (its own tools / project notes); acpbot does not ship a host-side memory skill or `memory_*` MCP tools.

## Install

```bash
acpbot skills install
```

Run after setup or skill upgrades. The **worker does not** install skills on boot.

Install targets (symlink preferred, copy fallback). Never overwrites a real directory that is not already an acpbot skill symlink:

- `~/.agents/skills/{telegram,schedules,multi-agent,autoreview,linear,eve,computer}`
- `~/.grok/skills/{telegram,schedules,multi-agent,autoreview,linear,eve,computer}`
- `~/.claude/skills/{telegram,schedules,multi-agent,autoreview,linear,eve,computer}`

Binary installs materialise skills under `~/.local/share/acpbot/bundled-skills/` when the package tree is not on disk.

## Discovery

| Path | Who uses it |
|---|---|
| Bundled root (package or materialised) | Always on `skillRoots` for Telegram `/skills` |
| `~/.agents/skills`, `~/.grok/skills`, `~/.claude/skills` | Global agent CLIs after `acpbot skills install` |
| Session cwd `.agents/skills` (etc.) | Per-repo overrides |

Extra roots: `[skills].roots` in `config.toml`, or env `ACPBOT_SKILL_ROOTS` (colon / semicolon / comma separated). See [Configuration](/docs/configuration).

## Telegram `/skills`

In a topic, `/skills` lists skills from config roots + session cwd, then composes a prompt for the agent with the chosen skill body.

## Related

- [MCP](/docs/mcp) — host tools those skills describe  
- [Schedules](/docs/schedules) — how host fire works  
- [Multi-agent](/docs/multi-agent) — spawn / wait / worktrees  
- [Review](/docs/review) — dual-agent closeout (`/review`, `review_run`)  
- [EVE](/docs/eve) — background directives over those tools  
- [Worker API](/docs/worker-api) — how outbound Telegram is delivered
