# Bundled tacp skills

Operator skills shipped with tacp and installed **globally** for coding agents
(Grok, Claude, Codex, …) in every workspace.

| Skill | Purpose |
|-------|---------|
| [`telegram`](./telegram/SKILL.md) | Progress, text, photo, file, voice via host MCP `tacp` |
| [`schedules`](./schedules/SKILL.md) | Delayed / recurring jobs via `schedule_*` tools |

## Install

```bash
bun run skills:install
```

Run after clone or skill upgrades. Worker boot does **not** install skills.

Installs (symlink preferred, copy fallback) into:

- `~/.agents/skills/`
- `~/.grok/skills/`
- `~/.claude/skills/`

Canonical source of truth: this directory in the tacp package.
