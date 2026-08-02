# Getting started

## Requirements

- A Telegram bot with **topic mode enabled** in private chats (@BotFather)
- For real agents: at least one CLI on `PATH` and logged in where required:
  - **Grok Build** — `grok` on `PATH` (`grok agent stdio`) and logged in
  - **Claude** — `claude` + `npx` (ACP adapter)
  - **Codex** — `codex` + `npx` (ACP adapter)
  - **OpenCode** — `opencode` (`opencode acp`)
- **From source only:** [Bun](https://bun.sh) (CI uses 1.3.x). Binary installs do not need Bun.

## 1. Provision the bot

@BotFather is not scriptable. Once per bot:

1. Create a bot → copy the **token**
2. Enable **topics in private chats** for that bot
3. Note your Telegram **user id** (e.g. `@userinfobot`)

Pair as operator after start: DM the bot for a code, then run `acpbot pair approve <code>` on the host. See [pairing.md](pairing.md).



## 2. Install & configure

```bash
git clone https://github.com/pmdroid/acpbot.git
cd acpbot
bun install
bun run skills:install   # once — global agent skills
```

`skills:install` symlinks (or copies) package skills into `~/.agents/skills`,
`~/.grok/skills`, and `~/.claude/skills`. The worker does **not** install skills on boot.

**Config is created automatically** on first start (no manual `mkdir` / `cp`).  
Full reference: [configuration.md](configuration.md).

## 3. Setup + start host and worker

**You need both processes:** host (agents) and worker (Telegram). The worker fails at boot if the host socket is missing.

### Recommended (binaries)

```bash
acpbot setup
# Guided TUI: config + API keys.
# Daemon step installs BOTH:
#   • acpbot-host  (LaunchAgent / systemd user unit)
#   • acpbot       (LaunchAgent / systemd user unit)

# Later:
acpbot-host start | stop | restart | status
# (same commands on `acpbot`; --host / --worker for one side)
```

If you skip the daemon step in setup:

```bash
acpbot-host    # terminal 1 — agent stdio, schedules, OAuth
acpbot         # terminal 2 — Telegram worker
# or: acpbot-host install && acpbot-host start
```

### From source (dev)

```bash
bun run acp-host    # terminal 1
bun run start       # terminal 2
```

In the private chat with the bot:

```text
/ping          → pong
/new acpbot hi   → creates a forum topic
# open the topic, type a prompt → real agent turn
```

On startup acpbot **wipes** stale `setMyCommands` scopes and registers the slash menu from the command registry. Slash commands never go to the agent.

Background service paths and logs: [configuration.md](configuration.md#background-services-host--worker).

In a topic:

| Command | Effect |
|---|---|
| type text | Start an ACP turn (or **queue** if a turn is already running) |
| `/steer <text>` | **Interrupt** the current turn and inject guidance now |
| `/queue` / `/unqueue` | List / remove waiting prompts |
| `/status` | Agent, model, mode, effort, cwd, MCP |
| `/model` | LLM picker (or `/model <id>`) |
| `/effort` | Reasoning effort (when the agent advertises it) |
| `/permissions` | Tool auto-approve: `ask` (default) or `always` |
| `/agent` | Switch agent process for this session |
| `/plan` / `/build` / `/mode` | Session plan/agent mode |
| `/skills` | Skill picker then prompt |
| `/mcp` | Per-repo remote MCP registry + OAuth |
| `/cancel` | Stop current turn **and clear the queue** (session kept) |

While a turn runs you will see a single **`⏳ Working…`** (or **`❓ Waiting…`**) message in the topic. Agents should call MCP **`update`** so that bubble shows progress; the final agent reply appears after it is removed. Forum topic titles stay fixed (`⏸ repo/name`).

**Busy-turn UX:** free-text is queued (non-interrupt) with a **Remove** button on the ack; `/steer …` interrupts. Telegram does not notify message deletes — use Remove or `/unqueue`.

Details: [commands.md](commands.md), [agents.md](agents.md), [architecture.md](architecture.md#turn-ux-working-bubble).

## 4. Media & speech (optional)

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

Full provider options: [configuration.md](configuration.md#speech-tts--stt-providers). Outbound path: [worker-api.md](worker-api.md).

## Common failures

| Symptom | Likely cause |
|---|---|
| Boot fails: topics disabled | Enable private-chat topics in @BotFather |
| No reply from non-you | Not paired, or a different Telegram account |
| Missing bot token | Create `~/.config/acpbot/config.toml` (see `config.example.toml`) |
| Agent picker empty | No agent CLIs on `PATH` (`grok`, `claude`, …) |
| Spawn dies immediately | Check agent login / adapter; stderr is logged |
| OAuth / host diverge | Worker and host must share the same `state_dir` / config file |
| `acp-host` exits on boot | OAuth listen port in use, or missing shared state dir |
| Speech silent / no STT | Set `[speech.openai]` or `[speech.elevenlabs]` keys; check `tts_provider` / `stt_provider` |

## Tests

```bash
bun test ./test
bun run typecheck
```

## Next

- [Architecture](architecture.md)
- [MCP](mcp.md) — per-repo tools & host `acpbot` tools  
- [Skills](skills.md) — bundled telegram + schedules, global install
- [OAuth](oauth.md) — remote gateways
