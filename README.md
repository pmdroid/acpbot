# tacp

Telegram control surface for ACP coding agents. Each agent session is a **topic**
in your private chat with the bot.

Local daemon, long-polling, single operator. **Bun + TypeScript**. Agent
sessions use a thin ACP host on the official
[`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk)
(stdio spawn + `session/new` / `prompt` / permissions / MCP).

## What “working” means right now

With a provisioned bot you can:

1. Start the daemon (syncs the Telegram **/** menu from the command registry)
2. **Lobby:** `/ping`, `/new`, `/sessions`, `/help`
3. `/new` → pick a repo (or `/new <repo> <name>`) → topic appears
4. **Topic:** type to prompt; send photos/files/voice; `/skills`, `/cancel`, `/help`
5. **Media:** images/docs → `.tacp-inbox/` (or ACP attach when enabled); voice → STT; agent-controlled **TTS** via host MCP tool `speak` (or `<<<speak>>>` marker) when a speech provider is configured

On startup tacp **wipes** stale `setMyCommands` scopes (default + private, en)
and registers the short menu (`ping`, `new`, `sessions`, `cancel`, `help`).
Slash commands never go to the agent. Lobby commands typed inside a topic get a
short “use the main chat” reply instead of starting a turn.

**Permissions:** inline keyboard; waiting-on-you rename before the prompt; confirm
by editing the message.

Agent text uses a **provisional volume policy**: buffer during the turn, flush
once at the end (chunked to Telegram’s limit).

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- A Telegram bot with **topic mode enabled** (@BotFather) — see below
- For real agents: `codex` / `claude` (etc.) installed and logged in on the host

## 1. Provision the bot (human — once)

@BotFather is not scriptable. You must:

1. Create a bot → copy the **token**
2. Enable **topics in private chats** for that bot
3. Note your Telegram **user id** (e.g. via `@userinfobot`)

## 2. Configure

```bash
cp .env.example .env
# edit .env — all paths are yours to choose
```

| Variable | Purpose |
|---|---|
| `TACP_BOT_TOKEN` | Bot token |
| `TACP_OPERATOR_USER_ID` | Your user id (allowlist) |
| `TACP_STORE_PATH` | Durable tacp JSON store file |
| `TACP_ACPX_STATE_DIR` | Directory reserved for host state (compat name) |
| `TACP_REPOS_JSON` | `{"repoKey":"/absolute/cwd",...}` |
| `TACP_AGENT_BACKEND` | `echo` (no agent) or `real` (ACP SDK host) |
| `TACP_DEFAULT_AGENT` | `grok-build` (Grok), `codex`, `claude`, … |
| `TACP_AGENT_COMMAND_JSON` | Optional spawn overrides |

### Connect to Grok

| tacp setting | value |
|---|---|
| `TACP_AGENT_BACKEND` | `real` |
| `TACP_DEFAULT_AGENT` | `grok-build` (or alias `grok`) |

Requires the **Grok Build CLI** on `PATH` (`grok agent stdio`) and a normal Grok login
(or `XAI_API_KEY`). Restart the daemon and create a session — prompts in the topic
run through Grok over ACP.

#### Host capabilities

| Feature | Status |
|---|---|
| Official `@agentclientprotocol/sdk` client | **Yes** (thin host in `src/acp/`) |
| `_x.ai/ask_user_question` → Telegram multi-choice | **Yes** |
| `elicitation/create` → buttons | **Yes** |
| `session/request_permission` → buttons | **Yes** |
| Client `fs/*` + `terminal/*` | **Yes** (host-side) |
| Host MCP `speak` via `mcpServers` | **Yes** |
| Telegram slash menu sync | **Yes** |

## 3. Run

```bash
bun install
bun test ./test

# prove Telegram without a coding agent login:
#   TACP_AGENT_BACKEND=echo
set -a && source .env && set +a
bun run src/main.ts
```

In Telegram (private chat with the bot):

```
/ping
/new tacp demo
# open the new topic, type: hello
# → topic status flips; echo/real agent reply appears in the topic
```

## Architecture

One seam: the `Environment` port (`telegram`, `agents`, `clock`, `store`).

```
src/core/     pure daemon
src/env/      ports + fakes + real telegram/agents + echo backend
src/main.ts   process entry
test/         acceptance tests
forks/acpx/   MIT fork with elicitation host hook
```

## Still open (not “forgot”, deliberately undecided)

| Area | Ticket |
|---|---|
| Permission / question round-trip UI | wayfinder 005 |
| Repo picker, cancel/end/delete semantics | wayfinder 006 |
| Full output volume policy | out of map scope |
| Measure `answerCallbackQuery` window | wayfinder 008 steps 6–7 |
