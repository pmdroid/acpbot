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
4. **Topic:** type to prompt; send photos/files/voice; `/status`, `/model`, `/agent`, `/plan`/`/build`/`/mode`, `/skills`, `/cancel`, `/help`
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
| Host MCP `update` / `telegram_send` (mid-turn text) | **Yes** (queue → topic; progress pings) |
| Topic `/model` `/agent` (LLM / process switch) | **Yes** (ACP configOptions + agent respawn) |
| Host MCP `schedule_*` (in-repo jobs) | **Yes** (CRUD + host auto-fire via acp-host) |
| Per-repo MCP from `.tacp/mcp.json` | **Yes** (stdio + http/sse; OAuth Bearer from host store) |
| Remote MCP OAuth (`/mcp auth`, host callback) | **Yes** (PKCE; tokens under `TACP_ACPX_STATE_DIR`) |
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

Topic commands: `/mcp status|add|remove` (registry id+url only) and
`/mcp auth <id>` / `/mcp code …` (OAuth — see below).

See also `demo/.tacp/mcp.json.example`.

### In-repo schedules (`.tacp/schedules/`)

Agents can create **durable jobs** via built-in MCP tools on server **`tacp`**:

| Tool | Action |
|------|--------|
| `schedule_create` | `prompt` (required) + optional `script` path + `once`/`cron` → `.tacp/schedules/<id>.json` |
| `schedule_list` | jobs for `TACP_SESSION_KEY` (or whole repo with `all: true`) |
| `schedule_cancel` | soft-disable for **this session** (`enabled: false`); `all: true` for any in-repo job |
| `schedule_run_now` | set `nextRunAt=now` so the host fires on the next tick |

`script` must be **relative to the repo root** (no `..` escapes). Prefer
`.tacp/schedules/scripts/<name>`. Cron is 5-field (`m h dom mon dow`). **Next-run
is always computed in UTC** for MVP — the `timezone` field is stored (and non-UTC
values get a create warning) but does **not** shift the schedule yet. When both
day-of-month and day-of-week are restricted, classic cron **OR** applies (either
may match).

**Host fire:** `bun run acp-host` scans each catalog repo (`TACP_REPOS_JSON`) under
`.tacp/schedules/` every `TACP_SCHEDULE_TICK_MS` (default 20s). Due jobs
(`enabled && nextRunAt <= now`) are **claimed on disk before** the agent turn
(`once` → `enabled: false`; `cron` → next `nextRunAt` from now) so a crash mid-fire
cannot double-run the same occurrence. Then the host ensures the job’s `sessionKey`
slot and prompts with an envelope (prompt + optional script path). Busy slots roll
the claim back, set `lastStatus: busy`, and retry next tick. Fire `error` leaves the
claim in place (no hot-loop; re-due once jobs via `schedule_run_now`). Works even if
the Telegram worker is down.

Skill: `demo/.agents/skills/schedule/`.

### Remote MCP OAuth

Tokens are **never** written to the repo (not under `.tacp/`). They live under:

`$TACP_ACPX_STATE_DIR/mcp-oauth/by-repo/<repoKey>/<id>.json` (files mode `0600`)

**Shared absolute state dir:** `/mcp auth` runs in the **Telegram worker** and
writes pending PKCE; `GET /oauth/callback` and session ensure run on **acp-host**.
Both processes must use the **same absolute** `TACP_ACPX_STATE_DIR` (resolved at
startup). Prefer an absolute path in `.env` so different CWDs cannot diverge.
Boot logs print the resolved path on both processes.

Flow:

1. Set `TACP_OAUTH_CALLBACK_BASE` to a URL the **phone browser** can reach
   (prefer **Tailscale Serve**; or `http://100.x.y.z:8788` on your tailnet).
2. Run `bun run acp-host` — it listens for `GET /oauth/callback` when the base is set.
   If bind fails (port in use), **acp-host exits** with a clear error; fix the port
   or use paste fallback below.
3. In a session topic: `/mcp add linear https://…` then `/mcp auth linear`.
4. Open the **tappable authorize URL** in Telegram (host does not open a browser).
5. On callback, PKCE completes and Bearer tokens are merged into remote MCP at ensure.
   Pending PKCE expires after **15 minutes**.

When `TACP_OAUTH_CALLBACK_BASE` is set, ensure **fail-closes** if a remote MCP
has no token: `MCP "<id>" has no OAuth token; run /mcp auth <id>`.

Fallback if the redirect cannot reach the host (or the listener failed):
prefer `/mcp code <full-callback-url>` (includes `code` + `state`); bare
`/mcp code <code> <id>` is last resort.

**Listen surface:** default `TACP_OAUTH_LISTEN_HOST=0.0.0.0` so phone redirects
work. Anyone who can hit the port can *attempt* a callback; protection is
high-entropy `state` + PKCE (`code_verifier` never leaves the host). Prefer
Serve/tailnet over public Funnel/IP without understanding that model.

**Discovery (no env client_id / auth URL):** on `/mcp auth`, tacp:

1. Probes the MCP URL for `WWW-Authenticate` `resource_metadata` (RFC 9728), else
   fetches `/.well-known/oauth-protected-resource…`
2. Loads authorization-server metadata (RFC 8414)
3. Dynamically registers a public PKCE client (`registration_endpoint`, RFC 7591)
4. Opens authorize with the registered `client_id` + `resource` indicator

The gateway must publish AS metadata with a registration endpoint. There are no
`TACP_MCP_OAUTH_*_AUTH_URL` / `_CLIENT_ID` overrides.

### MCP profiles (one profile per repo)

Use a profile allowlist when a repo’s `mcp.json` has more servers than a given
workflow should see (e.g. automation tools vs coding-only). Today **`mcpProfile`
is repo-global** — every session in that repo gets the same filter. Per-topic /
per-session selection is not wired yet (the build path accepts an override for
tests / future Telegram hooks).

`<repo>/.tacp/config.json`:

```json
{
  "defaultAgent": "grok-build",
  "mcpProfile": "automation"
}
```

`<repo>/.tacp/mcp.profiles.json`:

```json
{
  "automation": ["schedule", "homeassistant"],
  "coding": []
}
```

Rules:

- If `mcpProfile` is set **and** the named key exists in `mcp.profiles.json`,
  repo MCP is filtered to that name list before merge with built-in `tacp`.
- Empty list `[]` → no repo MCP for that profile (built-in `tacp` still added).
- Allowlist names with no match in `mcp.json` are ignored (may yield empty repo
  MCP + still `tacp`).
- Missing config, missing profiles file, **unknown** profile name, or
  **invalid/unreadable** config or profiles JSON → no filter (all servers from
  `mcp.json`). Fail-open paths log a **warn** when a profile was requested but
  could not be applied (typo / missing file).
- `defaultAgent` is read from config for future per-repo agent defaults; session
  create still uses the global `TACP_DEFAULT_AGENT` / config default today.


## ACP host (keep agents alive across worker restarts)

Like Ursula’s `acp-host`: a long-lived process owns agent stdio for **any** ACP agent
(not Grok-leader-specific). The Telegram worker can restart and reattach.
Also fires in-repo schedules into the right session slots.

```bash
# Terminal 1 — agent owner (+ schedule ticker when TACP_REPOS_JSON is set)
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
