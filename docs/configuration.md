# Configuration

acpbot is configured with a **TOML file** and sensible defaults for binary /
launchd / systemd installs. You do **not** need a wall of environment variables.

## Config file location

| Priority | Path |
|---|---|
| 1 | `--config PATH` / `-c PATH` |
| 2 | `$ACPBOT_CONFIG` |
| 3 | `~/.config/acpbot/config.toml` (or `$XDG_CONFIG_HOME/acpbot/config.toml`) |
| 4 | `./config.toml` (cwd) if present |

**First run (no manual mkdir/cp):** starting `acpbot-host` or `acpbot` creates:

- `~/.config/acpbot/config.toml` (mode `600`) if missing  
- `~/.local/share/acpbot/` (store + state)

### Guided setup TUI

```bash
acpbot setup          # or: acpbot init · acpbot --setup
# Safe to re-run: loads current config.toml as defaults, keeps unedited keys
```

Interactive (@clack) walkthrough (re-run anytime):

| Step | What |
|---|---|
| Telegram | Bot token; operator claim-on-first-DM **or** numeric user id |
| Agent | grok-build · claude · codex · opencode |
| Tool permissions | `permission_mode = "ask"` (default) or `"bypass"` |
| Workspace | Optional `[repos]` entry for `/new` |
| Speech | TTS mode + OpenAI / ElevenLabs API keys & voice |
| OAuth | Optional `callback_base` (setup detects Tailscale DNS / IP / LAN) |
| Log level | Optional `log_level` (`info` default) |
| Daemon | Installs **both** host and worker as background services (see below) |

First plain `acpbot` start also opens the TUI if `bot_token` is still a placeholder.  
Non-interactive boots need a real `bot_token` already in the file.

Operator allowlist is **not** in TOML — pair with `acpbot pair approve` after a Telegram DM. See [pairing.md](pairing.md).

Worker and **acp-host must use the same file** (or the same `state_dir`).

## Background services (host + worker)

acpbot is **two processes**. Setup installs **both** when you accept the daemon step
(requires `acpbot` and `acpbot-host` on `PATH`):

| Service | Binary | Role |
|---|---|---|
| **Host** | `acpbot-host` | Agent stdio owner, schedule ticker, OAuth HTTP |
| **Worker** | `acpbot` | Telegram long-poll, worker API, topics |

They share the same `config.toml` / `state_dir`. The worker fails boot if the host
socket is missing; with restart policies both recover if one starts slightly late.

### macOS (LaunchAgents)

Written under `~/Library/LaunchAgents/` (user session, no root):

| Plist | Process |
|---|---|
| `app.acpbot.host.plist` | `acpbot-host --config …` |
| `app.acpbot.worker.plist` | `acpbot --config …` |

Both use `RunAtLoad` + `KeepAlive`. Logs: `~/.local/share/acpbot/logs/`  
(`host.out.log` / `host.err.log` / `worker.out.log` / `worker.err.log`).

```bash
# status
launchctl print gui/$(id -u)/app.acpbot.host
launchctl print gui/$(id -u)/app.acpbot.worker

# stop
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/app.acpbot.host.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/app.acpbot.worker.plist
```

### Linux (systemd user)

Written under `~/.config/systemd/user/`:

| Unit | Process |
|---|---|
| `acpbot-host.service` | `acpbot-host --config …` |
| `acpbot.service` | `acpbot --config …` |

```bash
systemctl --user enable --now acpbot-host acpbot
systemctl --user status acpbot-host acpbot
journalctl --user -u acpbot-host -u acpbot -f

# optional: keep running after logout
loginctl enable-linger $USER
```

### Service CLI (`install` / `start` / `stop` / `restart`)

Works on **both** `acpbot` and `acpbot-host` (same commands). By default each
action applies to **host and worker**.

```bash
acpbot-host install     # write units + enable/start both services
acpbot-host start       # start both
acpbot-host stop        # stop both (worker first)
acpbot-host restart     # stop then start
acpbot-host status      # show running state
acpbot-host uninstall   # stop + remove unit files

# same on the worker binary:
acpbot install | start | stop | restart | status | uninstall

# host or worker only:
acpbot start --host
acpbot stop --worker
```

Requires binaries on `PATH` for `install`. Prefer `acpbot setup` the first time
(config + optional install), then use `start` / `stop` / `restart` day-to-day.

### Manual (foreground, no daemon)

```bash
# terminal 1
acpbot-host --config ~/.config/acpbot/config.toml
# terminal 2
acpbot --config ~/.config/acpbot/config.toml
```

## Defaults (no config keys required for paths)

| Setting | Default |
|---|---|
| `store_path` | `~/.local/share/acpbot/store.json` |
| `state_dir` | `~/.local/share/acpbot/state` |
| `default_agent` | `grok-build` |
| `log_level` | `info` |
| `features.mcp` | `true` |
| `features.tts_mode` | `agent` |

`state_dir` holds sockets (`acp-host.sock`, `worker-api.sock`), ACP session
records, and OAuth tokens. Keep it private (owner-only).

`$XDG_DATA_HOME` / `$XDG_CONFIG_HOME` are honored when set.

## Required keys (Telegram worker)

```toml
bot_token = "…"           # @BotFather — required
```

| Key | Why |
|---|---|
| `bot_token` | Telegram Bot API auth |

**acp-host** does not require the bot token; it only needs the shared `state_dir`
and optional `[repos]` / `[oauth]` / `[schedule]`.

## Example

```toml
bot_token = "123456:ABC…"
default_agent = "grok-build"
log_level = "info"

[repos]
demo = "/Users/you/code/demo"

[features]
mcp = true
tts_mode = "agent"           # when the agent may speak: agent | always | off

[oauth]
# callback_base = "http://your-host.ts.net:8788"  # setup detects Tailscale DNS / IP / LAN
# listen_port = 8788

[schedule]
# tick_ms = 20000

[speech]
tts_provider = "auto"        # auto | openai | elevenlabs | off
stt_provider = "auto"

[speech.openai]
# api_key = "sk-…"
# tts_voice = "alloy"
```

Full annotated template: [`config.example.toml`](../config.example.toml).

## Docker

Mount a config file and set `ACPBOT_CONFIG`:

```yaml
environment:
  ACPBOT_CONFIG: /data/config.toml
volumes:
  - ./config.toml:/data/config.toml:ro
  - acpbot-data:/data
```

Override `store_path` / `state_dir` inside the TOML to paths under `/data`
(see compose defaults in `docker-compose.yml`).

## Speech (TTS / STT providers)

TTS and STT are chosen **independently**.

| `tts_provider` / `stt_provider` | Meaning |
|---|---|
| `auto` (default) | ElevenLabs if its key is set, else OpenAI |
| `openai` | OpenAI (or OpenAI-compatible `base_url`) |
| `elevenlabs` | ElevenLabs |
| `off` | That side disabled |

### OpenAI (first-class)

```toml
[speech]
tts_provider = "openai"
stt_provider = "openai"

[speech.openai]
api_key = "sk-…"
# base_url = "https://api.openai.com/v1"   # or Azure / compatible proxy
tts_model = "tts-1"          # tts-1 | tts-1-hd | gpt-4o-mini-tts
tts_voice = "alloy"          # alloy | ash | ballad | coral | echo | fable | nova | onyx | sage | shimmer | verse
tts_format = "opus"          # opus preferred for Telegram voice notes; mp3 also fine
stt_model = "whisper-1"      # whisper-1 | gpt-4o-mini-transcribe | gpt-4o-transcribe
```

### ElevenLabs

```toml
[speech]
tts_provider = "elevenlabs"
stt_provider = "elevenlabs"

[speech.elevenlabs]
api_key = "…"
voice_id = "…"               # premade/cloned voice id
# tts_model = "eleven_multilingual_v2"
# stt_model = "scribe_v1"
# base_url = "https://api.elevenlabs.io"
```

### Mixed providers

```toml
[speech]
tts_provider = "openai"
stt_provider = "elevenlabs"
```

### Nested form (optional)

```toml
[speech.tts]
provider = "openai"
model = "tts-1-hd"
voice = "nova"
format = "opus"

[speech.stt]
provider = "openai"
model = "whisper-1"
```

### When vs which

| Setting | Controls |
|---|---|
| `features.tts_mode` | **When** the agent speaks: `agent` (MCP `speak` only) \| `always` \| `off` |
| `speech.tts_provider` / `stt_provider` | **Which API** synthesizes / transcribes |

## Environment variable overrides

Optional **overrides** for CI, Docker, or scripts. Day-to-day use prefers TOML (`config.toml`).

| Env override | TOML equivalent |
|---|---|
| `ACPBOT_BOT_TOKEN` | `bot_token` |
| `ACPBOT_STORE_PATH` | `store_path` |
| `ACPBOT_STATE_DIR` | `state_dir` |
| `ACPBOT_REPOS_JSON` | `[repos]` |
| `ACPBOT_DEFAULT_AGENT` | `default_agent` |
| `ACPBOT_LOG_LEVEL` | `log_level` |
| `ACPBOT_OAUTH_CALLBACK_BASE` | `[oauth].callback_base` |
| `ACPBOT_CONFIG` | path to TOML |
| `ACPBOT_TTS_PROVIDER` / `ACPBOT_STT_PROVIDER` | `auto` \| `elevenlabs` \| `openai` \| `off` |
| `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` | speech secrets |

## Related

- [Getting started](getting-started.md)
- [Architecture](architecture.md) — state dir layout
- [OAuth](oauth.md)
