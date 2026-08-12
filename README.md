<p align="center">
  <img src="website/public/assets/acpbot-logo.png" alt="acpbot" width="420" />
</p>

# acpbot

**Telegram control surface for ACP coding agents.**  
**Site:** [acpbot.app](https://acpbot.app) · **Docs:** [docs](https://acpbot.app/docs) · **License:** [MIT](LICENSE)

Each agent session is a **forum topic** in your private chat with the bot. Talk to Grok, Claude, Codex, or OpenCode from Telegram — permissions, media, MCP tools, and schedules on **your** machine.

```text
You (Telegram) ──topic──► acpbot ──ACP──► grok / claude / codex / opencode / cursor
```

---

## Disclaimer — use at your own risk

**acpbot runs coding agents that can read and write files, execute shell commands, call network tools, and spend API quota on any machine you attach.**

- You are **solely responsible** for allowlists, repos, credentials, and agent permissions.
- The authors are **not responsible** for damage, data loss, security incidents, leaked secrets, unexpected costs, or other consequences.
- Prefer **ask** / cautious modes when available, and review permission prompts.
- Provided **“AS IS”** under the [MIT License](LICENSE), without warranty.

By running acpbot you accept these terms.

---

## Features

- **Topic = session** — `/new` opens a forum topic bound to a repo + agent
- **Real agents** — Grok Build, Claude, Codex, OpenCode
- **`/model` · `/effort` · `/agent` · `/mode`** — switch mid-session without leaving the topic
- **Working bubble** — one live `⏳` / `❓` status message per turn
- **Permissions in chat** — inline keyboards for ACP prompts
- **Media & speech** — photos, files, voice; OpenAI or ElevenLabs TTS/STT
- **Schedules** — delayed/recurring jobs even when the Telegram worker is down
- **Queue & steer** — free-text queues while busy; `/steer` interrupts
- **Multi-agent & EVE** — spawn children in worktrees; agent-authored directive graphs
- **Multi-host** — route repos to remote `acp-host` over WSS

---

## Install

No Bun or source checkout required for normal use.

### 1. Bot (once)

In [@BotFather](https://t.me/BotFather): create a bot, enable **topics in private chats**, note your Telegram user id. Install at least one agent CLI on `PATH` (`grok`, `claude`, `codex`, `opencode`, or `cursor-agent`).

### 2. Download the binary

**[v0.1.0](https://github.com/pmdroid/acpbot/releases/tag/v0.1.0)** — download **one** binary for your platform (`linux-x64`, `linux-arm64`, or signed `darwin-arm64` / `darwin-x64`). Platform table + Docker: [acpbot.app](https://acpbot.app/#install).

```bash
# Apple Silicon example
curl -fsSL -o acpbot.tar.gz \
  "https://github.com/pmdroid/acpbot/releases/download/v0.1.0/acpbot-v0.1.0-darwin-arm64.tar.gz"
tar -xzf acpbot.tar.gz
chmod +x acpbot-v0.1.0-darwin-arm64
sudo mv acpbot-v0.1.0-darwin-arm64 /usr/local/bin/acpbot
acpbot help    # host, worker, setup, services, …
```

Docker: `docker pull ghcr.io/pmdroid/acpbot:v0.1.0`

### 3. Guided setup TUI

```bash
acpbot setup          # re-run anytime
# After first DM to the bot:
acpbot pair approve ABCD-1234
```

Walks through bot token, agent, workspace, speech keys, OAuth, then optionally installs **both** background services (same binary, two processes):

| Service | Command | Role |
|---|---|---|
| Host | `acpbot host` | Agents, schedules, OAuth |
| Worker | `acpbot worker` | Telegram |

- **macOS:** `app.acpbot.host` + `app.acpbot.worker` LaunchAgents (`KeepAlive`)  
- **Linux:** `acpbot-host.service` + `acpbot.service` (systemd user)

Same `config.toml` for both. Logs: `~/.local/share/acpbot/logs/` (macOS) or `journalctl --user -u acpbot-host -u acpbot` (Linux).  
Details: [Configuration](https://acpbot.app/docs/configuration#background-services-host--worker).

Day-to-day service control (default = **both** host + worker):

```bash
acpbot install    # write + enable LaunchAgents / systemd units
acpbot start
acpbot stop
acpbot restart
acpbot status
# one side only: acpbot start --host   ·   acpbot stop --worker
```

Foreground (no service):

```bash
acpbot host      # terminal 1 — required first
acpbot worker    # terminal 2
```

Bare `acpbot` prints help. Use `acpbot setup` for the TUI when config is missing.

### 4. Telegram

```text
/ping
/new demo hello
# open the topic → type a prompt

/status  /model  /effort  /agent  /mode  /skills  /mcp  /cancel  /fresh
# while busy: free-text is queued; /steer <text> interrupts
# /fresh = new agent conversation (history cleared; topic kept)
```

More: [acpbot.app/docs](https://acpbot.app/docs)

---

## Documentation

| | |
|---|---|
| [Docs home](https://acpbot.app/docs) | Full operator docs (Astro site) |
| [Getting started](https://acpbot.app/docs/getting-started) | Install, pair, first topic |
| [Configuration](https://acpbot.app/docs/configuration) | TOML, speech providers, paths |
| [Commands](https://acpbot.app/docs/commands) | Lobby & topic commands |
| [Architecture](https://acpbot.app/docs/architecture) | How the pieces fit |
| [Source](website/src/content/docs/) | Markdown in the website package |

---

## License

[MIT](LICENSE) — free to use, modify, and distribute. **No warranty; no liability for damages.** See the [Disclaimer](#disclaimer--use-at-your-own-risk) above.
