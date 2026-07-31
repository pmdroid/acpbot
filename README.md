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
4. **Topic:** type to prompt; send photos/files/voice; `/plan`/`/build`/`/mode`, `/skills`, `/cancel`, `/help`
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
| Client `fs/*` + `terminal/*` | **Yes** (acpx-grade TerminalManager: limits, process-group kill) |
| Host MCP `speak` via `mcpServers` | **Yes** |
| Per-repo MCP from `.tacp/mcp.json` | **Yes** (stdio + http/sse pass-through) |
| Durable session store (`TACP_ACPX_STATE_DIR/sessions`) | **Yes** (session/load when agent supports it) |
| Telegram slash menu sync | **Yes** |

### Per-repo MCP (`.tacp/mcp.json`)

Each session’s **cwd** (repo root) may declare MCP servers at
`<repo>/.tacp/mcp.json`. On `session/new` / ensure, tacp loads that file,
resolves **relative path-like** tokens from the repo root (write them as
`./path` or `.tacp/…`; rejects `..` escapes outside the repo), injects
`TACP_SESSION_KEY` / `TACP_REPO_ROOT` / `TACP_STATE_DIR`, then **merges repo
servers first** and built-in host tools (`speak`, name `tacp`) after.

**Absolute** command/arg paths are allowed (system/shared tools). Only relative
path-like tokens are constrained to the repo. Containment is lexical (no
symlink follow). npm package specs (`@scope/pkg`), CLI flags, and bare binaries
are left unchanged. The name `tacp` is reserved for the built-in server.

Missing or invalid JSON → built-in only (warn on invalid). Example:

```json
{
  "mcpServers": [
    {
      "name": "local-tools",
      "command": "bun",
      "args": ["run", ".tacp/tools/server.ts"],
      "env": { "FOO": "bar" }
    }
  ]
}
```

See also `demo/.tacp/mcp.json.example`.

## ACP host (keep agents alive across worker restarts)

Like Ursula’s `acp-host`: a long-lived process owns agent stdio for **any** ACP agent
(not Grok-leader-specific). The Telegram worker can restart and reattach.

```bash
# Terminal 1 — agent owner
bun run acp-host

# Terminal 2 — Telegram worker
TACP_ACP_HOST=1 set -a && source .env && set +a && bun run start
```

Socket default: `$TACP_ACPX_STATE_DIR/acp-host.sock`.  
If the socket already exists, the worker auto-uses the host unless `TACP_ACP_HOST=0`.

On worker disconnect, slots stay warm. Host SIGTERM disposes all agent processes.
See `docs/ideas/agent-host-keepalive.md`.

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
