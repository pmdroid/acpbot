# Changelog

## [Unreleased]

## [0.4.0] — 2026-09-04

### Added

- **Pi** — built-in `pi` registry entry (`npx -y pi-acp@0.0.33`), aliases (`pi.dev`, `pi-dev`, `pi-acp`, `pi-coding-agent`). Requires `npx` + the [Pi](https://pi.dev) CLI on `PATH`. Pin override: `agents.pi_acp_pkg` / `ACPBOT_PI_ACP_PKG`.

### Install

- Binaries: [v0.4.0](https://github.com/pmdroid/acpbot/releases/tag/v0.4.0) (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`)
- Docker: `ghcr.io/pmdroid/acpbot:v0.4.0` (`:0.4.0`, `:latest`)

## [0.3.1] — 2026-08-26

### Changed

- **Quieter Telegram** — agent text is held until the turn ends (no mid-turn paragraph posts). Working bubble, queue acks, slash replies, and `telegram_send` use `disable_notification`. Final agent reply, failures, plan-ready, permission/ask, EVE done/ask, photos/files/voice, and child summaries still notify.

### Install

- Binaries: [v0.3.1](https://github.com/pmdroid/acpbot/releases/tag/v0.3.1) (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`)
- Docker: `ghcr.io/pmdroid/acpbot:v0.3.1` (`:0.3.1`, `:latest`)

## [0.3.0] — 2026-08-26

### Removed

- **Native Linear integration** — `/linear`, `linear_*` MCP tools, topic↔project bindings, Linear skill, and the Linear docs page. Track work in **GitHub issues** (`gh issue`, or add GitHub MCP with `/mcp add`). Generic remote MCP OAuth is unchanged.

### Fixed / hardened

- **Setup fails closed without Threaded Mode** — `acpbot setup` calls `getMe` after the bot token and **does not write config or install services** when `has_topics_enabled` is false. BotFather labels this **Threaded Mode** (same flag as topics in private chats). Worker boot uses the same wording (no more “restart tacp”).
- **`/new` without a repo** — empty `[repos]` tells you to run `acpbot repo add`. You cannot start a session until a workspace exists. Setup outro, `/help`, and getting-started say the same.
- **Setup projects folder** — the folder browser may open on a parent (`~/code`, `~/Projects`). That parent is not a workspace. Browse into the project, then Use this folder. Full Disk Access does not register repos. Docs match.

### Install

- Binaries: [v0.3.0](https://github.com/pmdroid/acpbot/releases/tag/v0.3.0) (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`)
- Docker: `ghcr.io/pmdroid/acpbot:v0.3.0` (`:0.3.0`, `:latest`)

## [0.2.2] — 2026-08-23

### Fixed / hardened

- **Leftover ACP `stop` after cancel / `/steer`** — `session/prompt` completion is bound to that turn's PromptResponse. A cancelled turn that returns before consuming its `stop` no longer makes the next prompt look like it finished in milliseconds (replayed tools, frozen ⏳, no real reply). Cancel waits briefly for the matching stop; if it times out, leftover updates are dropped until that stop drains.

### Changed

- **macOS Darwin releases** — `scripts/release-darwin.sh` notarizes Developer ID builds (`ditto` zip → `notarytool`). `--skip-notarize` is for local experiments. Naked Mach-O is not stapled; first launch of a quarantined download needs network so Gatekeeper can fetch the ticket.
- **EVE quieter Telegram** — the topic stays silent except when the run is **done** (`🌱` / failed / killed) or **help is needed** (approve, `host.ask`, blocked). No started/approved/progress/digest lines. `/eve status` is a short glance. Set `[eve].digest_interval_sec = 0` only if you want the old per-line chatter.

### Install

- Binaries: [v0.2.2](https://github.com/pmdroid/acpbot/releases/tag/v0.2.2) (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`)
- Docker: `ghcr.io/pmdroid/acpbot:v0.2.2` (`:0.2.2`, `:latest`)

## [0.2.1] — 2026-08-13

### Added

- **EVE `host.ask` / `/eve answer`** — park a run as `waiting_user` and collect an operator decision (Telegram buttons + `/eve answer <runId> <n>`)

### Fixed / hardened

- **EVE blocked ≠ complete** — a directive that returns `blocked` (or any leaf `status: "blocked"`) no longer gets `🌱 EVE complete`. The host parks the run as `waiting_user` and asks the operator. Scripts can `await host.ask({ question, options })` mid-run so a stuck review cannot die quietly.
- **EVE / review: Cursor is first-class** — Eve recipes tell leaves to honor a requested reviewer (`agent: "cursor-agent"` or helper `--engine cursor`). Unset helper `--engine` still defaults to Codex; do not fall through when the operator asked for Composer.

### Install

- Binaries: [v0.2.1](https://github.com/pmdroid/acpbot/releases/tag/v0.2.1) (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`)
- Docker: `ghcr.io/pmdroid/acpbot:v0.2.1` (`:0.2.1`, `:latest`)

## [0.2.0] — 2026-08-12

### Added

- **Cursor Agent** — built-in `cursor-agent` registry entry (`cursor-agent acp`), aliases (`cursor`, `cursor-cli`), docs; ACP `authenticate` when agents advertise `authMethods` (e.g. `cursor_login`)
- **Dual-agent closeout review** — `/review` and MCP `review_run` freeze a git bundle (local dirty or branch), run two ACP reviewers in **panel** or **adversarial** mode, merge structured findings; skill `autoreview`; docs [Review](https://acpbot.app/docs/review)
- Artifacts under `$state_dir/reviews/<id>/` (`bundle.diff`, `result.json` / `result.md`)

### Fixed / hardened

- Session **ensure** coalescing per slot, bounded ensure RPC timeout, hung `session/load` / `session/new` recovery
- Working-status bubble re-post so progress stays last; progressive mid-turn paragraph flushes

### Install

- Binaries: [v0.2.0](https://github.com/pmdroid/acpbot/releases/tag/v0.2.0) (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`)
- Docker: `ghcr.io/pmdroid/acpbot:v0.2.0` (`:0.2.0`, `:latest`)

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
