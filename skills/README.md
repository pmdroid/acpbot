# Bundled acpbot skills

Operator skills shipped with acpbot and installed **globally** for coding agents
(Grok, Claude, Codex, …) in every workspace.

| Skill | Purpose |
|-------|---------|
| [`telegram`](./telegram/SKILL.md) | Progress, text, photo, file, voice via host MCP `acpbot` |
| [`schedules`](./schedules/SKILL.md) | Delayed / recurring jobs via `schedule_*` tools |
| [`multi-agent`](./multi-agent/SKILL.md) | Spawn child agents in git worktrees |
| [`autoreview`](./autoreview/SKILL.md) | Two-agent panel / adversarial closeout review |
| [`linear`](./linear/SKILL.md) | Linear MCP + topic↔project binding |
| [`eve`](./eve/SKILL.md) | EVE background multi-agent directives (agent-authored JS graphs; no shipped scripts) |
| [`computer`](./computer/SKILL.md) | Isolated Playwright browser (`computer_*`; `/computer on` required) |

## Credits

Structured closeout review, priority-gated findings, and multi-reviewer panel ideas for [`autoreview`](./autoreview/SKILL.md) draw from the [OpenClaw autoreview skill](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview). acpbot’s implementation is ACP-native (`/review`, `review_run`).

## Install

```bash
acpbot skills install
```

Works from the **release binary** (skills are embedded) and from a source
checkout (uses package `skills/`). Run after setup or skill upgrades.
Worker boot does **not** install skills.

Installs (symlink preferred, copy fallback) into:

- `~/.agents/skills/`
- `~/.grok/skills/`
- `~/.claude/skills/`

Binary materialises skills under `~/.local/share/acpbot/bundled-skills/` when
the package tree is not on disk.
