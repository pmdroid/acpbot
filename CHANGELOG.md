# Changelog

## [0.1.0] — 2026-08-07

First public release as **acpbot**.

### Install

- **Binaries** on [GitHub Releases](https://github.com/pmdroid/acpbot/releases/tag/v0.1.0):
  `darwin-arm64` / `darwin-x64` (Developer ID–signed), `linux-x64` / `linux-arm64`
- **Docker** multi-arch image: `ghcr.io/pmdroid/acpbot:v0.1.0` (`:0.1.0`, `:latest`)
- Site + docs: [acpbot.app](https://acpbot.app)

### Added

- Telegram worker + required **acp-host** process model
- ACP agents: Grok Build, Claude, Codex, OpenCode
- `/status`, `/model`, `/mode`, `/agent`, sessions, MCP, schedules, OAuth
- CLI operator **pairing** (`acpbot pair approve`) — no operator id in config
- Free-text while a turn is busy is **queued** (FIFO); **`/steer`**, **`/queue`**, **`/unqueue`**
- Stronger MCP **`update`** tool description + telegram skill habit for the Working bubble
- **Multi-agent spawn** — parent-linked children via MCP, git worktrees, A2A
- **EVE** (*Extraterrestrial Vegetation Evaluator*) — background multi-agent **directives**:
  agent-authored JS graphs with zero-token orchestration on **acp-host**; leaf `agent()`
  via host slots + worktrees. Commands `/eve` (alias `/directive`), MCP `eve_*` tools,
  skill `eve`. Agents write graphs with `eve_write` / inline `source`. `/linear drain`
  kicks an agent turn to author + run a drain directive.
- **Multi-host** — route repos to remote `acp-host` over authenticated WSS
- **Linear** MCP binding + topic↔project skill
- Live host-client contract tests; default session mode prefers **ask**
- Docker Compose (host + worker isolation)
- GitHub Actions CI + Release (Linux compile + GHCR; macOS via `scripts/release-darwin.sh`)
- Static landing page under `website/` (acpbot.app)
- MIT license, README disclaimer, SECURITY.md

### Notes

- **Config is TOML-first:** `~/.config/acpbot/config.toml` (see `config.example.toml`); store/state default under `~/.local/share/acpbot/`. Env overrides use **`ACPBOT_*`**
- **Speech providers:** independent TTS/STT selection (`auto` \| `elevenlabs` \| `openai` \| `off`) via `[speech]` / `[speech.openai]` / `[speech.elevenlabs]`; OpenAI is first-class
- **Guided setup TUI** (`acpbot setup`): bot token, agent, repos, speech API keys, OAuth; optional **macOS LaunchAgent** / **Linux systemd user** install for host + worker
- Per-repo config under **`.acpbot/`** (`mcp.json`, schedules, profiles)
- No shipped EVE directive scripts — agents author workflows via the skill
