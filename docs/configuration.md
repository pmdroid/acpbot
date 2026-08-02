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
```

Interactive (@clack) walkthrough:

| Step | What |
|---|---|
| Telegram | Bot token; operator claim-on-first-DM **or** numeric user id |
| Agent | grok-build · claude · codex · opencode |
| Workspace | Optional `[repos]` entry for `/new` |
| Speech | TTS mode + OpenAI / ElevenLabs API keys & voice |
| OAuth | Optional `callback_base` for remote MCP |
| Daemon | **macOS** LaunchAgents or **Linux** systemd user units for host + worker |

Services run as your user (no root). Logs:

- macOS: `~/.local/share/acpbot/logs/`
- Linux: `journalctl --user -u acpbot-host -u acpbot -f`

First plain `acpbot` start also opens the TUI if `bot_token` is still a placeholder.  
Non-interactive boots need a real `bot_token` already in the file.

**`operator_user_id`** is the allowlist (only that Telegram account can control the bot).

Worker and **acp-host must use the same file** (or the same `state_dir`).

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
operator_user_id = 0      # 0 = first DM claims the bot; or set your user id
```

| Key | Why |
|---|---|
| `bot_token` | Telegram Bot API auth |
| `operator_user_id` | **Security allowlist** — anyone who can talk to the bot could otherwise run agents on your machine. Set explicitly, or leave `0` and claim with the first private message |

**acp-host** does not require the bot token; it only needs the shared `state_dir`
and optional `[repos]` / `[oauth]` / `[schedule]`.

## Example

```toml
bot_token = "123456:ABC…"
operator_user_id = 42
default_agent = "grok-build"
log_level = "info"

[repos]
demo = "/Users/you/code/demo"

[features]
mcp = true
tts_mode = "agent"           # when the agent may speak: agent | always | off

[oauth]
# callback_base = "https://your-host.ts.net"
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

## launchd / systemd

Point both processes at the same config:

```bash
# macOS launchd ProgramArguments example
/usr/local/bin/acpbot-host --config /Users/you/.config/acpbot/config.toml
/usr/local/bin/acpbot --config /Users/you/.config/acpbot/config.toml
```

No env file is required. Optional: set only `ACPBOT_CONFIG` if you prefer not to
pass `--config`.

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

## Legacy environment variables

Still accepted as **overrides** (CI, old scripts), but not required:

| Env (prefer `ACPBOT_*`) | TOML equivalent |
|---|---|
| `ACPBOT_BOT_TOKEN` | `bot_token` |
| `ACPBOT_OPERATOR_USER_ID` | `operator_user_id` |
| `ACPBOT_STORE_PATH` | `store_path` |
| `ACPBOT_STATE_DIR` | `state_dir` |
| `ACPBOT_REPOS_JSON` | `[repos]` |
| `ACPBOT_DEFAULT_AGENT` | `default_agent` |
| `ACPBOT_LOG_LEVEL` | `log_level` |
| `ACPBOT_OAUTH_CALLBACK_BASE` | `[oauth].callback_base` |
| `ACPBOT_CONFIG` | path to TOML |
| `ACPBOT_TTS_PROVIDER` / `ACPBOT_STT_PROVIDER` | `auto` \| `elevenlabs` \| `openai` \| `off` |
| `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` | speech secrets |

`TACP_*` remains a legacy alias for the same keys.

## Related

- [Getting started](getting-started.md)
- [Architecture](architecture.md) — state dir layout
- [OAuth](oauth.md)
