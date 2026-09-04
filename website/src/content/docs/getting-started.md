---
title: Getting started
description: Binary install from GitHub Releases, setup, pair, first topic.
order: 1
section: start
---

No Bun or source checkout required for normal use. Download a **[v0.3.1](https://github.com/pmdroid/acpbot/releases/tag/v0.3.1)** release binary, run setup, pair once.

## Requirements

- A Telegram bot with **Threaded Mode** on in [@BotFather](https://t.me/BotFather) (Bot Settings; Telegram also calls this topics in private chats)
- Shell access on the host (to approve pairing — you do **not** need a Telegram user id first)
- At least one agent CLI on `PATH` and logged in where required:
  - **Grok Build** — `grok` (`grok agent stdio`)
  - **Claude** — `claude` + `npx` (ACP adapter)
  - **Codex** — `codex` + `npx` (ACP adapter)
  - **OpenCode** — `opencode` (`opencode acp`)
  - **Cursor Agent** — `cursor-agent` (`cursor-agent acp`; run `cursor-agent login` once)
  - **Pi** — `pi` + `npx` (ACP adapter `pi-acp`; install from [pi.dev](https://pi.dev))

## 1. Provision the bot

@BotFather is not scriptable. Once per bot:

1. Create a bot → copy the **token**
2. Open the BotFather mini app (the **Open** button), pick the bot → **Bot Settings** → enable **Threaded Mode**. Chat-style BotFather commands do not always show this toggle. Telegram also calls it topics in private chats. `acpbot setup` checks `getMe.has_topics_enabled` and **stops** if it is false.

Pair as operator after start: DM the bot for a code, then run `acpbot pair approve <code>` on the host. See [Pairing](/docs/pairing).

## 2. Download the binary

Current release: **[v0.3.1](https://github.com/pmdroid/acpbot/releases/tag/v0.3.1)**. Download **one** artifact for your platform (or use the [landing page install section](/#install)):

| Platform | Artifact | Direct link |
|---|---|---|
| macOS Apple Silicon | `acpbot-v0.3.1-darwin-arm64.tar.gz` (notarized) | [download](https://github.com/pmdroid/acpbot/releases/download/v0.3.1/acpbot-v0.3.1-darwin-arm64.tar.gz) |
| macOS Intel | `acpbot-v0.3.1-darwin-x64.tar.gz` (notarized) | [download](https://github.com/pmdroid/acpbot/releases/download/v0.3.1/acpbot-v0.3.1-darwin-x64.tar.gz) |
| Linux x86_64 | `acpbot-v0.3.1-linux-x64.tar.gz` | [download](https://github.com/pmdroid/acpbot/releases/download/v0.3.1/acpbot-v0.3.1-linux-x64.tar.gz) |
| Linux arm64 | `acpbot-v0.3.1-linux-arm64.tar.gz` | [download](https://github.com/pmdroid/acpbot/releases/download/v0.3.1/acpbot-v0.3.1-linux-arm64.tar.gz) |

One unified binary — host and worker are subcommands of `acpbot`.

```bash
# Apple Silicon example (swap the asset name for your platform)
curl -fsSL -o acpbot.tar.gz \
  "https://github.com/pmdroid/acpbot/releases/download/v0.3.1/acpbot-v0.3.1-darwin-arm64.tar.gz"
tar -xzf acpbot.tar.gz
chmod +x acpbot-v0.3.1-darwin-arm64
sudo mv acpbot-v0.3.1-darwin-arm64 /usr/local/bin/acpbot   # or ~/.local/bin
acpbot help    # host, worker, setup, services, …
```

Checksums ship on the release (`SHA256SUMS`, `SHA256SUMS-darwin-v0.3.1`).

**Config is created automatically** on first start under `~/.config/acpbot/` (no manual `mkdir` / `cp`).  
Full reference: [Configuration](/docs/configuration).

### Docker (optional)

```bash
docker pull ghcr.io/pmdroid/acpbot:v0.3.1
# or compose from the repo — see docker-compose.yml and Configuration → Docker
```

Image tags: `v0.3.1`, `0.3.1`, `latest`. Multi-arch (`linux/amd64`, `linux/arm64`).

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

**You must add a project folder before `/new`.** Setup’s folder browser often starts in a parent like `~/code` or `~/Projects`. That parent is not the workspace. Browse **into** the project, then **Use this folder**. If you skip this in the wizard, `/new` cannot start a session until you run:

```bash
acpbot repo add
# or: acpbot repo add demo ~/code/demo
# host/worker hot-reload [repos]; no restart needed
```

See [Repos](/docs/repos).

Optional — install bundled skills (`telegram`, `schedules`, `multi-agent`, `eve`) into global agent dirs so Grok/Claude/… see them outside Telegram:

```bash
acpbot skills install
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

## 5. Add a workspace repo

`/new` will not create a session until `[repos]` has at least one entry. Each entry is **one project folder**, not the parent that holds many projects.

```bash
acpbot repo add
# folder browser: go into the project, then Use this folder
# or: acpbot repo add demo ~/code/demo
```

macOS Full Disk Access (offered in setup) only lets agents **read** those paths. It does not add repos. Skip the workspace step and Telegram `/new` replies that you need `acpbot repo add` first.

## 6. Use Telegram

```text
/ping
/new
# pick a repo, name the session, open that topic → type a prompt

/status   /model   /effort   /agent   /mode   /skills   /mcp   /cancel
# while busy: free-text is queued; /steer <text> interrupts
```

On startup acpbot **wipes** stale `setMyCommands` scopes and registers the slash menu from the command registry. Slash commands never go to the agent.

| Command | Effect |
|---|---|
| type text | Start an ACP turn (or **queue** if a turn is already running) |
| `/steer <text>` | **Interrupt** the current turn and inject guidance now |
| `/queue` / `/unqueue` | List / remove waiting prompts |
| `/status` | Agent, model, mode, effort, cwd, MCP; spawned children / parent link when multi-agent |
| `/model` | LLM picker (or `/model <id>`) |
| `/effort` | Reasoning effort (when the agent advertises it) |
| `/permissions` | Tool policy: `ask` (default) or `bypass` |
| `/agent` | Switch agent process for this session |
| `/plan` / `/build` / `/mode` | Session plan/agent mode |
| `/skills` | Skill picker then prompt |
| `/mcp` | Per-repo remote MCP registry + OAuth |
| `/cancel` | Stop current turn **and clear the queue** (session kept) |

While a turn runs you will see a single **`⏳`** (or **`❓`**) status bubble in the topic. It updates in place as tools run. The final reply appears after the bubble is removed. Forum topic titles stay fixed (`repo/name`).

**Busy-turn UX:** free-text is queued (non-interrupt) with a **Remove** button on the ack; `/steer …` interrupts. Telegram does not notify message deletes — use Remove or `/unqueue`.

Details: [Commands](/docs/commands), [Agents](/docs/agents), [Architecture](/docs/architecture#turn-ux-working-bubble).

## 7. Media & speech (optional)

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
| Setup or worker: topics disabled | Enable **Threaded Mode** in @BotFather (Bot Settings), then re-run `acpbot setup` |
| `/new` says no repos | Run `acpbot repo add` on the host, then `/new` again |
| No reply from non-you | Not paired, or a different Telegram account |
| Missing bot token | Run `acpbot setup` or edit `~/.config/acpbot/config.toml` |
| Agent picker empty | No agent CLIs on `PATH` (`grok`, `claude`, …) |
| Spawn dies immediately | Check agent login / adapter; stderr is logged |
| OAuth / host diverge | Worker and host must share the same `state_dir` / config file |
| `acpbot host` exits on boot | OAuth listen port in use, or missing shared state dir |
| Speech silent / no STT | Set `[speech.openai]` or `[speech.elevenlabs]` keys; check `tts_provider` / `stt_provider` |

## From source (developers only)

Binary installs do not need Bun. For contributors, build or run via Bun, but
**all operator commands stay `acpbot`**:

```bash
git clone https://github.com/pmdroid/acpbot.git
cd acpbot
bun install
bun run build:compile    # → dist/acpbot
# or during dev: bun run src/main.ts <command>

acpbot skills install    # global agent skills
acpbot host              # terminal 1
acpbot worker            # terminal 2
```

```bash
bun test ./test
bun run typecheck
```

## Next

- [Architecture](/docs/architecture)
- [MCP](/docs/mcp) — per-repo tools & host `acpbot` tools  
- [Skills](/docs/skills) — bundled skills, global install
- [Multi-agent](/docs/multi-agent) · [EVE](/docs/eve)
- [OAuth](/docs/oauth) — remote MCP gateways
