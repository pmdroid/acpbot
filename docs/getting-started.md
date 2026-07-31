# Getting started

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- A Telegram bot with **topic mode enabled** in private chats (@BotFather)
- For real agents: at least one CLI on `PATH` and logged in where required:
  - **Grok Build** — `grok` (`grok agent stdio`), or `XAI_API_KEY`
  - **Claude** — `claude` + `npx` (ACP adapter)
  - **Codex** — `codex` + `npx` (ACP adapter)
  - **OpenCode** — `opencode` (`opencode acp`)

## 1. Provision the bot

@BotFather is not scriptable. Once per bot:

1. Create a bot → copy the **token**
2. Enable **topics in private chats** for that bot
3. Note your Telegram **user id** (e.g. `@userinfobot`)

tacp only accepts updates from `TACP_OPERATOR_USER_ID`. Everyone else is ignored.

## 2. Install & configure

```bash
git clone https://github.com/pmdroid/tacp.git
cd tacp
bun install
cp .env.example .env
# Install operator skills (telegram + schedules) into global agent skill dirs
bun run skills:install
```

`skills:install` symlinks (or copies) package skills into `~/.agents/skills`,
`~/.grok/skills`, and `~/.claude/skills` so **all** coding agents see them, not
only the demo repo. The worker also runs this on startup unless
`TACP_SKIP_SKILL_INSTALL=1`.

Edit `.env` (paths are yours to choose — nothing assumes a fixed home layout):

```bash
TACP_BOT_TOKEN=...
TACP_OPERATOR_USER_ID=...
TACP_STORE_PATH=./data/tacp-store.json
# Prefer absolute so worker + acp-host always share the same dir
TACP_ACPX_STATE_DIR=/absolute/path/to/tacp/data/acpx-state
TACP_REPOS_JSON='{"demo":"/absolute/path/to/tacp/demo","tacp":"/absolute/path/to/tacp"}'
TACP_AGENT_BACKEND=echo   # start with echo; switch to real later
```

Full reference: [configuration.md](configuration.md).

## 3. Smoke-test Telegram (`echo` backend)

```bash
set -a && source .env && set +a
bun run start
```

In the private chat with the bot:

```text
/ping          → pong
/new demo hi   → creates a forum topic
# open the topic, type: hello
# → echo agent replies in-topic
```

On startup tacp **wipes** stale `setMyCommands` scopes and registers the slash menu from the command registry. Slash commands never go to the agent.

## 4. Run a real agent

```bash
# .env
TACP_AGENT_BACKEND=real
TACP_DEFAULT_AGENT=grok-build   # or claude | codex | opencode
```

Optional but recommended — keep agents warm across worker restarts:

```bash
# Terminal 1 — owns agent stdio + schedule ticker + OAuth callback
bun run acp-host

# Terminal 2 — Telegram worker
TACP_ACP_HOST=1 bun run start
```

If `acp-host.sock` already exists under `TACP_ACPX_STATE_DIR`, the worker auto-attaches unless `TACP_ACP_HOST=0`.

In a topic:

| Command | Effect |
|---|---|
| type text | Start an ACP turn |
| `/status` | Agent, model, mode, cwd, MCP |
| `/model` | LLM picker (or `/model <id>`) |
| `/agent` | Switch agent process for this session |
| `/plan` / `/build` / `/mode` | Session mode |
| `/skills` | Skill picker then prompt |
| `/mcp` | Per-repo remote MCP registry + OAuth |
| `/cancel` | Stop current turn (session kept) |

Details: [commands.md](commands.md), [agents.md](agents.md).

## 5. Media & speech (optional)

| Direction | Behavior |
|---|---|
| Photo / document → agent | Saved under `.tacp-inbox/` (or ACP content blocks if `TACP_ACP_MEDIA_ATTACHMENTS=1`) |
| Voice → agent | STT when ElevenLabs / OpenAI keys are set |
| Agent → voice | MCP `speak` → TTS → `sendVoice` |
| Agent → photo / file | MCP `telegram_send_photo` / `telegram_send_file` (path under session repo) |

Speech env vars are documented in [configuration.md](configuration.md). Outbound path: [worker-api.md](worker-api.md).

## Common failures

| Symptom | Likely cause |
|---|---|
| Boot fails: topics disabled | Enable private-chat topics in @BotFather |
| No reply from non-you | `TACP_OPERATOR_USER_ID` mismatch |
| Agent picker empty | No agent CLIs on `PATH` (`grok`, `claude`, …) |
| Spawn dies immediately | Check agent login / adapter; stderr is logged |
| OAuth / host diverge | Relative `TACP_ACPX_STATE_DIR` + different CWDs — use absolute |
| `acp-host` exits on boot | OAuth listen port in use, or missing shared state dir |

## Tests

```bash
bun test ./test
bun run typecheck
```

## Next

- [Architecture](architecture.md)
- [MCP](mcp.md) — per-repo tools & host `tacp` tools  
- [Skills](skills.md) — bundled telegram + schedules, global install
- [OAuth](oauth.md) — remote gateways
