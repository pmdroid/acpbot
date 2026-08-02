# Getting started

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- A Telegram bot with **topic mode enabled** in private chats (@BotFather)
- For real agents: at least one CLI on `PATH` and logged in where required:
  - **Grok Build** — `grok` on `PATH` (`grok agent stdio`) and logged in
  - **Claude** — `claude` + `npx` (ACP adapter)
  - **Codex** — `codex` + `npx` (ACP adapter)
  - **OpenCode** — `opencode` (`opencode acp`)

## 1. Provision the bot

@BotFather is not scriptable. Once per bot:

1. Create a bot → copy the **token**
2. Enable **topics in private chats** for that bot
3. Note your Telegram **user id** (e.g. `@userinfobot`)

acpbot only accepts updates from `operator_user_id` in your config. Everyone else is ignored.

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

## 3. Start host + worker (real ACP)

**acp-host is required.** The worker fails at boot if the host socket is missing or does not answer ping.

```bash
# Terminal 1 — owns agent stdio + schedule ticker + OAuth callback
bun run acp-host
# or: acpbot-host

# Terminal 2 — first run opens setup wizard (bot token, user id, optional repo)
bun run start
# or: acpbot
```

In the private chat with the bot:

```text
/ping          → pong
/new acpbot hi   → creates a forum topic
# open the topic, type a prompt → real agent turn
```

On startup acpbot **wipes** stale `setMyCommands` scopes and registers the slash menu from the command registry. Slash commands never go to the agent.

Start `bun run acp-host` first so `acp-host.sock` exists; then `bun run start`.

In a topic:

| Command | Effect |
|---|---|
| type text | Start an ACP turn (or **queue** if a turn is already running) |
| `/steer <text>` | **Interrupt** the current turn and inject guidance now |
| `/queue` / `/unqueue` | List / remove waiting prompts |
| `/status` | Agent, model, mode, cwd, MCP |
| `/model` | LLM picker (or `/model <id>`) |
| `/agent` | Switch agent process for this session |
| `/plan` / `/build` / `/mode` | Session mode |
| `/skills` | Skill picker then prompt |
| `/mcp` | Per-repo remote MCP registry + OAuth |
| `/cancel` | Stop current turn **and clear the queue** (session kept) |

While a turn runs you will see a single **`⏳ Working…`** (or **`❓ Waiting…`**) message in the topic. Agents should call MCP **`update`** so that bubble shows progress; the final agent reply appears after it is removed. Forum topic titles stay fixed (`⏸ repo/name`).

**Busy-turn UX:** free-text is queued (non-interrupt) with a **Remove** button on the ack; `/steer …` interrupts. Telegram does not notify message deletes — use Remove or `/unqueue`.

Details: [commands.md](commands.md), [agents.md](agents.md), [architecture.md](architecture.md#turn-ux-working-bubble).

## 5. Media & speech (optional)

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
| No reply from non-you | `operator_user_id` mismatch in `config.toml` |
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
