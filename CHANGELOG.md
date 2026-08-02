# Changelog

## [0.1.0] — 2026-08-01

First public release as **acpbot** (formerly tacp).

### Added
- Telegram worker + required **acp-host** process model
- ACP agents: Grok Build, Claude, Codex, OpenCode
- `/status`, `/model`, `/mode`, `/agent`, sessions, MCP, schedules, OAuth
- Live host-client contract tests; default session mode prefers **ask**
- Docker Compose (host + worker isolation)
- GitHub Actions CI + Release (Bun compile multi-platform + GHCR images)
- Static landing page under `website/` (acpbot.app)
- MIT license, README disclaimer, SECURITY.md
- Free-text while a turn is busy is **queued** (FIFO, non-interrupt); **`/steer <text>`** interrupts and injects guidance now; **`/queue`**, **`/unqueue`**, and a **Remove** button on the queue ack manage waiting items (Telegram message delete is not supported)
- Stronger MCP **`update`** tool description + telegram skill habit so agents keep the ⏳ Working… bubble useful mid-turn

### Notes
- **Config is TOML-first:** `~/.config/acpbot/config.toml` (see `config.example.toml`); store/state default under `~/.local/share/acpbot/`. Env vars remain optional overrides; prefer `ACPBOT_*` / `TACP_*` legacy aliases only for CI/migration
- **Speech providers:** independent TTS/STT selection (`auto` \| `elevenlabs` \| `openai` \| `off`) via `[speech]` / `[speech.openai]` / `[speech.elevenlabs]`; OpenAI is first-class (Whisper + TTS), not only a fallback
- Repo config prefers `.acpbot/`; legacy `.tacp/` still loads when present
