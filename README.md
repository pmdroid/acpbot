# tacp

**Telegram control surface for ACP coding agents.**

Each agent session is a **forum topic** in your private chat with the bot. A local Bun daemon long-polls Telegram, spawns (or reattaches to) ACP agents over stdio, and bridges permissions, media, MCP tools, and speech into the topic.

```text
You (Telegram) ──topic──► tacp worker ──ACP──► grok / claude / codex / opencode
                              │
                              ├── worker-api.sock  ◄── host MCP tools (speak, photo, …)
                              └── acp-host.sock    (optional long-lived agent owner)
```

| | |
|---|---|
| **Runtime** | [Bun](https://bun.sh) ≥ 1.1 + TypeScript |
| **Protocol** | [Agent Client Protocol](https://agentclientprotocol.com) via [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) |
| **Operator model** | Single allowlisted user, private chat, topic-per-session |
| **License** | MIT |

---

## Features

- **Lobby → topic sessions** — `/new` opens a forum topic bound to a repo + agent
- **Real agents** — Grok Build, Claude, Codex, OpenCode (PATH-gated picker)
- **Mid-session switch** — `/model` and `/agent` without leaving the topic
- **Working bubble** — one editable `⏳` / `❓` status message per turn (MCP `update`); topic titles stay fixed
- **Permissions & questions** — inline keyboards for ACP permissions, elicitation, ask-user
- **Media in / out** — photos, files, voice STT; agent TTS / photo / file via MCP
- **Host MCP** — built-in `tacp` tools + per-repo `.tacp/mcp.json` (stdio / HTTP / SSE)
- **Remote MCP OAuth** — PKCE + dynamic client registration; tokens stay off-repo
- **Schedules** — durable in-repo jobs; `acp-host` fires them even if the worker is down
- **acp-host required** — agent processes live in the host; worker fails boot if host is down

Full capability matrix and design notes live under [`docs/`](docs/).

---

## Quick start

### 1. Provision the bot (once)

In [@BotFather](https://t.me/BotFather):

1. Create a bot → copy the **token**
2. Enable **topics in private chats**
3. Note your Telegram **user id** (e.g. via `@userinfobot`)

### 2. Configure

```bash
cp .env.example .env
# edit .env
```

Minimum:

| Variable | Purpose |
|---|---|
| `TACP_BOT_TOKEN` | Bot token |
| `TACP_OPERATOR_USER_ID` | Your user id (allowlist) |
| `TACP_STORE_PATH` | Durable JSON store path |
| `TACP_STATE_DIR` | Host state dir (sessions, OAuth, sockets) — prefer **absolute** |
| `TACP_REPOS_JSON` | `{"repoKey":"/absolute/cwd",…}` |
| `TACP_DEFAULT_AGENT` | `grok-build` (default), `claude`, `codex`, `opencode`, … |

See [docs/configuration.md](docs/configuration.md) and [docs/getting-started.md](docs/getting-started.md).

### 3. Run

```bash
bun install
bun run skills:install   # once: global telegram + schedules skills for all agents
bun test ./test

set -a && source .env && set +a
bun run acp-host         # required
bun run start            # worker (does not reinstall skills)
```

**Real ACP agents** (default). Example with Grok:

```bash
# TACP_DEFAULT_AGENT=grok-build   # requires `grok` on PATH + normal Grok login
bun run start
```

**Required layout** (worker will not start without acp-host):

```bash
# Terminal 1 — agents + schedule ticker + OAuth callback
bun run acp-host

# Terminal 2 — Telegram worker + worker API (fails boot if host socket is down)
bun run start
```

### 4. In Telegram

```text
/ping
/new tacp hello
# open the new topic → type a prompt
# /status  /model  /agent  /mode  /skills  /mcp  /cancel
```

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Bot setup, first session, common failures |
| [docs/architecture.md](docs/architecture.md) | Processes, ports, data flow |
| [docs/commands.md](docs/commands.md) | Lobby vs topic slash commands |
| [docs/agents.md](docs/agents.md) | Agent registry, `/model`, `/agent` |
| [docs/mcp.md](docs/mcp.md) | Built-in tools, `.tacp/mcp.json`, profiles |
| [docs/worker-api.md](docs/worker-api.md) | Unix outbound API for MCP → Telegram |
| [docs/schedules.md](docs/schedules.md) | Delayed/recurring jobs and host ticker |
| [docs/skills.md](docs/skills.md) | Bundled telegram + schedules skills, global install |
| [docs/oauth.md](docs/oauth.md) | Remote MCP OAuth (PKCE + DCR) |
| [docs/configuration.md](docs/configuration.md) | Full environment reference |
| [docs/ideas/](docs/ideas/) | Design notes / future work |

---

## Project layout

```text
src/
  main.ts           Telegram worker entry
  config.ts         Env / config load
  core/             Daemon, commands, media, worker API server
  acp/              Thin ACP session host (SDK client)
  acp-host/         Long-lived agent owner + schedule ticker + OAuth HTTP
  mcp/              Host MCP server, repo MCP, OAuth, worker-api client
  env/              Environment port (telegram, agents, store, speech)
  schedules/        In-repo schedule store helpers
test/               Acceptance + unit tests (bun test)
skills/             Bundled agent skills (telegram, schedules) — installed globally on onboard
docs/               Operator & architecture docs
```

---

## Development

```bash
bun install
bun test ./test          # full suite
bun run typecheck        # tsc --noEmit
bun run start            # worker
bun run acp-host         # required host
```

One seam: the `Environment` port (`telegram`, `agents`, `clock`, `store`). Core daemon code stays pure; fakes live under `src/env/` for tests.

---

## Status

Working end-to-end for a single operator: lobby, topics, real ACP agents, permissions, media, host MCP (including mid-turn Telegram send + speech), schedules, and remote MCP OAuth.

Deliberately open product/UI tickets (volume policy polish, richer session lifecycle UI, etc.) are tracked outside this README — see `docs/ideas/` for architecture follow-ups.
