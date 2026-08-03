---
title: Getting started
description: Binary install from GitHub Releases, setup, pair, first topic.
order: 1
section: start
---

No Bun or source checkout required for normal use. Download a release binary, run setup, pair once.

## Requirements

- A Telegram bot with **topic mode enabled** in private chats ([@BotFather](https://t.me/BotFather))
- Shell access on the host (to approve pairing — you do **not** need a Telegram user id first)
- At least one agent CLI on `PATH` and logged in where required:
  - **Grok Build** — `grok` (`grok agent stdio`)
  - **Claude** — `claude` + `npx` (ACP adapter)
  - **Codex** — `codex` + `npx` (ACP adapter)
  - **OpenCode** — `opencode` (`opencode acp`)

## 1. Provision the bot

@BotFather is not scriptable. Once per bot:

1. Create a bot → copy the **token**
2. Enable **topics in private chats** for that bot

Pair as operator after start: DM the bot for a code, then run `acpbot pair approve <code>` on the host. See [Pairing](/docs/pairing).

## 2. Download the binary

From [GitHub Releases](https://github.com/pmdroid/acpbot/releases) download **one** binary for your platform:

| Platform | Artifact |
|---|---|
| Linux x64 | `acpbot-v*-linux-x64.tar.gz` |
| Linux arm64 | `acpbot-v*-linux-arm64.tar.gz` |
| macOS Apple Silicon | `acpbot-v*-darwin-arm64.tar.gz` (signed) |
| macOS Intel | `acpbot-v*-darwin-x64.tar.gz` (signed) |

One unified binary — host and worker are subcommands of `acpbot`.

```bash
# example: v0.1.0 on Apple Silicon — use the latest tag from Releases
curl -sL -o acpbot.tar.gz \
  "https://github.com/pmdroid/acpbot/releases/download/v0.1.0/acpbot-v0.1.0-darwin-arm64.tar.gz"
tar -xzf acpbot.tar.gz
chmod +x acpbot-v0.1.0-darwin-arm64
sudo mv acpbot-v0.1.0-darwin-arm64 /usr/local/bin/acpbot
acpbot help    # host, worker, setup, services, …
```

**Config is created automatically** on first start under `~/.config/acpbot/` (no manual `mkdir` / `cp`).  
Full reference: [Configuration](/docs/configuration).

## 3. Setup + start host and worker

**You need both processes:** host (agents) and worker (Telegram). The worker fails at boot if the host socket is missing.

```bash
acpbot setup
# Guided TUI: bot token, agent, workspace, speech keys, optional OAuth callback.
# OAuth step can suggest Tailscale DNS / Tailscale IP / LAN IP, or a custom URL.
# macOS: offers Full Disk Access so agents can read real folders.
# Daemon step installs BOTH (same binary, two processes):
#   • acpbot host    (LaunchAgent / systemd)
#   • acpbot worker  (LaunchAgent / systemd)
```

| Service | Command | Role |
|---|---|---|
| Host | `acpbot host` | Agents, schedules, OAuth |
| Worker | `acpbot worker` | Telegram |

- **macOS:** `app.acpbot.host` + `app.acpbot.worker` LaunchAgents (`KeepAlive`)
- **Linux:** `acpbot-host.service` + `acpbot.service` (systemd user)

Same `~/.config/acpbot/config.toml` for both (mode `600`). Logs: `~/.local/share/acpbot/logs/` on macOS, or `journalctl --user -u acpbot-host -u acpbot` on Linux.

Day-to-day service control (default = **both** host + worker):

```bash
acpbot install    # write + enable LaunchAgents / systemd units
acpbot start
acpbot stop
acpbot restart
acpbot status
# one side only: acpbot start --host   ·   acpbot stop --worker
```

If you skip the daemon step in setup:

```bash
acpbot host      # terminal 1 — agent stdio, schedules, OAuth
acpbot worker    # terminal 2 — Telegram
```

Workspace roots (folder browser) — see [Repos](/docs/repos):

```bash
acpbot repo
acpbot repo add demo ~/code/demo
# host/worker hot-reload [repos]; restart worker only if needed
```

Background service paths: [Configuration](/docs/configuration#background-services-host--worker).

## 4. Pair as operator

The bot starts **unpaired**. Approve on the host CLI:

1. Open a **private** chat with the bot and send any message (e.g. `/ping`).
2. The bot replies with a **pairing code** (e.g. `AB3K-9Q2M`).
3. On the machine running acpbot:

```bash
acpbot pair list
acpbot pair approve AB3K-9Q2M
acpbot pair status
```

Details: [Pairing](/docs/pairing).

## 5. Use Telegram

```text
/ping
/new demo hello
# open the new forum topic → type a prompt

/status   /model   /effort   /agent   /mode   /skills   /mcp   /cancel
# while busy: free-text is queued; /steer <text> interrupts
```

On startup acpbot **wipes** stale `setMyCommands` scopes and registers the slash menu from the command registry. Slash commands never go to the agent.

| Command | Effect |
|---|---|
| type text | Start an ACP turn (or **queue** if a turn is already running) |
| `/steer <text>` | **Interrupt** the current turn and inject guidance now |
| `/queue` / `/unqueue` | List / remove waiting prompts |
| `/status` | Agent, model, mode, effort, cwd, MCP |
| `/model` | LLM picker (or `/model <id>`) |
| `/effort` | Reasoning effort (when the agent advertises it) |
| `/permissions` | Tool policy: `ask` (default) or `bypass` |
| `/agent` | Switch agent process for this session |
| `/plan` / `/build` / `/mode` | Session plan/agent mode |
| `/skills` | Skill picker then prompt |
| `/mcp` | Per-repo remote MCP registry + OAuth |
| `/cancel` | Stop current turn **and clear the queue** (session kept) |

While a turn runs you will see a single **`⏳`** (or **`❓`**) status bubble in the topic. It updates in place as tools run. The final reply appears after the bubble is removed. Forum topic titles stay fixed (`⏸ repo/name`).

**Busy-turn UX:** free-text is queued (non-interrupt) with a **Remove** button on the ack; `/steer …` interrupts. Telegram does not notify message deletes — use Remove or `/unqueue`.

Details: [Commands](/docs/commands), [Agents](/docs/agents), [Architecture](/docs/architecture#turn-ux-working-bubble).

## 6. Media & speech (optional)

| Direction | Behavior |
|---|---|
| Photo / document → agent | Saved under `.acpbot-inbox/` (or ACP content blocks if `features.acp_media_attachments = true`) |
| Voice → agent | STT via configured provider (`auto` / `openai` / `elevenlabs`) |
| Agent → voice | MCP `speak` → TTS (same provider selection) → `sendVoice` |
| Agent → photo / file | MCP `telegram_send_photo` / `telegram_send_file` (path under session repo) |

OpenAI-only example:

```toml
[speech]
tts_provider = "openai"
stt_provider = "openai"

[speech.openai]
api_key = "sk-…"
tts_voice = "alloy"
```

Full provider options: [Configuration](/docs/configuration#speech-tts--stt-providers). Outbound path: [Worker API](/docs/worker-api).

## Common failures

| Symptom | Likely cause |
|---|---|
| Boot fails: topics disabled | Enable private-chat topics in @BotFather |
| No reply from non-you | Not paired, or a different Telegram account |
| Missing bot token | Run `acpbot setup` or edit `~/.config/acpbot/config.toml` |
| Agent picker empty | No agent CLIs on `PATH` (`grok`, `claude`, …) |
| Spawn dies immediately | Check agent login / adapter; stderr is logged |
| OAuth / host diverge | Worker and host must share the same `state_dir` / config file |
| `acpbot host` exits on boot | OAuth listen port in use, or missing shared state dir |
| Speech silent / no STT | Set `[speech.openai]` or `[speech.elevenlabs]` keys; check `tts_provider` / `stt_provider` |

## From source (developers only)

Binary installs do not need Bun. For contributors:

```bash
git clone https://github.com/pmdroid/acpbot.git
cd acpbot
bun install
bun run skills:install   # optional — global agent skills
bun run acp-host         # terminal 1  (= acpbot host)
bun run start            # terminal 2  (= acpbot worker)
```

```bash
bun test ./test
bun run typecheck
```

## Next

- [Architecture](/docs/architecture)
- [MCP](/docs/mcp) — per-repo tools & host `acpbot` tools  
- [Skills](/docs/skills) — bundled telegram + schedules, global install
- [OAuth](/docs/oauth) — remote gateways
