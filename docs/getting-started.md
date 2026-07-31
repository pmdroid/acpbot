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
TACP_DEFAULT_AGENT=grok-build   # or claude | codex | opencode
```

Full reference: [configuration.md](configuration.md).

## 3. Start worker + host (real ACP)

Recommended layout:

```bash
set -a && source .env && set +a

# Terminal 1 — owns agent stdio + schedule ticker + OAuth callback
bun run acp-host

# Terminal 2 — Telegram worker + worker API (uses acp-host by default)
bun run start
```

To spawn agents inside the worker instead of acp-host (not recommended):

```bash
TACP_ACP_HOST=0 bun run start
```

In the private chat with the bot:

```text
/ping          → pong
/new demo hi   → creates a forum topic
# open the topic, type a prompt → real agent turn
```

On startup tacp **wipes** stale `setMyCommands` scopes and registers the slash menu from the command registry. Slash commands never go to the agent.

The worker **always** attaches to acp-host unless `TACP_ACP_HOST=0`. Start `bun run acp-host` first (or together) so the socket is available.

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

While a turn runs you will see a single **`⏳ Working…`** (or **`❓ Waiting…`**) message in the topic. MCP `update` rewrites that bubble; the final agent reply appears after it is removed. Forum topic titles stay fixed (`⏸ repo/name`).

Details: [commands.md](commands.md), [agents.md](agents.md), [architecture.md](architecture.md#turn-ux-working-bubble).

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
