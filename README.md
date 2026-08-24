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

In [@BotFather](https://t.me/BotFather): create a bot, enable **Threaded Mode** (Bot Settings; also called topics in private chats). Setup will not finish until `getMe.has_topics_enabled` is true. Install at least one agent CLI on `PATH` (`grok`, `claude`, `codex`, `opencode`, or `cursor-agent`).

### 2. Download the binary

**[v0.2.2](https://github.com/pmdroid/acpbot/releases/tag/v0.2.2)** — download **one** binary for your platform (`linux-x64`, `linux-arm64`, or notarized `darwin-arm64` / `darwin-x64`). Platform table + Docker: [acpbot.app](https://acpbot.app/#install).

```bash
# Apple Silicon example
curl -fsSL -o acpbot.tar.gz \
  "https://github.com/pmdroid/acpbot/releases/download/v0.2.2/acpbot-v0.2.2-darwin-arm64.tar.gz"
tar -xzf acpbot.tar.gz
chmod +x acpbot-v0.2.2-darwin-arm64
sudo mv acpbot-v0.2.2-darwin-arm64 /usr/local/bin/acpbot
acpbot help    # host, worker, setup, services, …
```

Docker: `docker pull ghcr.io/pmdroid/acpbot:v0.2.2`

### 3. Guided setup TUI

```bash
acpbot setup          # re-run anytime
# After first DM to the bot:
acpbot pair approve ABCD-1234
```

Walks through bot token, agent, workspace, speech keys, OAuth, then optionally installs **both** background services (same binary, two processes). **Add a project folder** during setup (browse into the project, not `~/Projects`) or later with `acpbot repo add`. `/new` cannot start a session without one.

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

### 4. Workspace repo (required)

```bash
acpbot repo add                # folder browser: pick the project folder itself
acpbot repo add demo ~/code/demo
```

Setup may open on a parent like `~/code`. That parent is not a workspace. Browse into the project, then **Use this folder**. `/new` cannot start a session until `[repos]` has an entry. Host and worker hot-reload the list.

### 5. Telegram

```text
/ping
/new
# pick a repo, name the session, open the topic → type a prompt

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
