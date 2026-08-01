<p align="center">
  <img src="website/assets/acpbot-logo.png" alt="acpbot" width="420" />
</p>

# acpbot

**Telegram control surface for ACP coding agents.**  
**Site:** [acpbot.app](https://acpbot.app) · **License:** [MIT](LICENSE)

Each agent session is a **forum topic** in your private chat with the bot. A local Bun daemon long-polls Telegram, spawns (or reattaches to) ACP agents over stdio, and bridges permissions, media, MCP tools, and speech into the topic.

```text
You (Telegram) ──topic──► acpbot worker ──ACP──► grok / claude / codex / opencode
                              │
                              ├── worker-api.sock  ◄── host MCP tools (speak, photo, …)
                              └── acp-host.sock    (required long-lived agent owner)
```

| | |
|---|---|
| **Runtime** | [Bun](https://bun.sh) ≥ 1.1 + TypeScript |
| **Protocol** | [Agent Client Protocol](https://agentclientprotocol.com) via [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) |
| **Operator model** | Single allowlisted user, private chat, topic-per-session |
| **Default session mode** | Prefer **ask** / permission-cautious modes when the agent advertises them |
| **License** | [MIT](LICENSE) |

---

## Disclaimer — use at your own risk

**acpbot runs coding agents that can read and write files, execute shell commands, call network tools, and spend API quota on any machine or container you attach.**

- You are **solely responsible** for configuring allowlists, repo mounts, credentials, and agent permissions.
- The authors and contributors are **not responsible** for any **damage**, data loss, security incidents, leaked secrets, unexpected costs, legal claims, or other consequences arising from use or misuse of this software.
- Default mode selection prefers **ask** / cautious modes when available, but agents may still request elevated tools; you must review permission prompts.
- This software is provided **“AS IS”** under the [MIT License](LICENSE), without warranty of any kind.

By running acpbot you accept these terms.

---

## Features

- **Lobby → topic sessions** — `/new` opens a forum topic bound to a repo + agent
- **Real agents** — Grok Build, Claude, Codex, OpenCode (PATH-gated picker)
- **Mid-session switch** — `/model` and `/agent` without leaving the topic
- **Working bubble** — one editable `⏳` / `❓` status message per turn
- **Permissions & questions** — inline keyboards for ACP permissions, elicitation, ask-user
- **Media in / out** — photos, files, voice STT; agent TTS / photo / file via MCP
- **Host MCP** — built-in `acpbot` tools + per-repo `.acpbot/mcp.json` (legacy `.tacp/` supported)
- **Remote MCP OAuth** — PKCE + dynamic client registration; tokens stay off-repo
- **Schedules** — durable in-repo jobs; `acp-host` fires them even if the worker is down
- **acp-host required** — agent processes live in the host; worker fails boot if host is down

Full docs: [`docs/`](docs/).

---

## Quick start (local)

### 1. Bot (once)

In [@BotFather](https://t.me/BotFather): create a bot, enable **topics in private chats**, note your Telegram user id.

### 2. Configure

```bash
cp .env.example .env
# edit .env — prefer ACPBOT_* (TACP_* still works as legacy alias)
```

| Variable | Purpose |
|---|---|
| `ACPBOT_BOT_TOKEN` | Bot token |
| `ACPBOT_OPERATOR_USER_ID` | Your user id (allowlist) |
| `ACPBOT_STORE_PATH` | Durable JSON store path |
| `ACPBOT_STATE_DIR` | Shared state dir (sessions, OAuth, sockets) — **absolute** preferred |
| `ACPBOT_REPOS_JSON` | `{"repoKey":"/absolute/cwd",…}` |
| `ACPBOT_DEFAULT_AGENT` | e.g. `grok-build`, `claude`, `codex`, `opencode` |

### 3. Run

```bash
bun install
bun run skills:install   # once
bun test ./test          # optional

set -a && source .env && set +a
bun run acp-host         # terminal 1 — required
bun run start            # terminal 2 — worker
```

### 4. Telegram

```text
/ping
/new demo hello
# open the topic → prompt
# /status  /model  /agent  /mode  /skills  /mcp  /cancel
# while busy: free-text is queued; /steer <text> interrupts; /queue · /unqueue
```

---

## Docker (host + worker isolation)

Two containers share a state volume; only the host publishes OAuth (optional). Agents are **not** fully baked into the image — mount CLIs and repos yourself.

```bash
cp .env.example .env
# set ACPBOT_BOT_TOKEN, ACPBOT_OPERATOR_USER_ID, and repos, e.g.:
# ACPBOT_REPOS_JSON='{"demo":"/repos/demo"}'
# ACPBOT_REPOS_HOST=./demo   # host path mounted at /repos/demo

docker compose up --build
```

| Service | Role |
|---|---|
| `acp-host` | Agent stdio owner, schedules, OAuth `:8788` |
| `worker` | Telegram poller; depends on healthy host socket |

```bash
bun run docker:build   # image acpbot:local
bun run docker:up
bun run docker:down
```

Mount agent binaries read-only when needed (see comments in `docker-compose.yml`).  
**Mounted repos are writable by agents — treat that as full trust of the operator + agent.**

---

## Standalone binaries (Bun compile)

```bash
bun run build:compile
# → dist/acpbot          (worker)
# → dist/acpbot-host     (host)
```

### GitHub Release (binaries + Docker)

Create a **Release** in GitHub (or push a `v*` tag). The [Release workflow](.github/workflows/release.yml) will:

1. Run unit tests  
2. Cross-compile versioned binaries and **attach them to the release**  
   - `acpbot-v0.1.0-linux-x64.tar.gz`, `acpbot-host-v0.1.0-darwin-arm64.tar.gz`, …  
3. Build multi-arch Docker and push to GHCR tagged with the release  
   - `ghcr.io/<owner>/<repo>:v0.1.0`  
   - `ghcr.io/<owner>/<repo>:0.1.0`  
   - `ghcr.io/<owner>/<repo>:latest`

```bash
# Option A — GitHub UI: Releases → Draft a new release → tag v0.1.0 → Publish
# Option B — CLI:
git tag v0.1.0 && git push origin v0.1.0
# then create a release for that tag (or let the workflow update it)
```

```bash
docker pull ghcr.io/<owner>/acpbot:v0.1.0
```

GHCR packages are private to the repo by default; make the package public under **Packages** if you want anonymous pulls.

Workflows: [`.github/workflows/ci.yml`](.github/workflows/ci.yml), [`.github/workflows/release.yml`](.github/workflows/release.yml).

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Bot setup, first session |
| [docs/architecture.md](docs/architecture.md) | Processes, sockets, data flow |
| [docs/commands.md](docs/commands.md) | Lobby vs topic commands |
| [docs/agents.md](docs/agents.md) | Agent registry, `/model`, `/agent` |
| [docs/mcp.md](docs/mcp.md) | Built-in tools, `.acpbot/mcp.json` |
| [docs/worker-api.md](docs/worker-api.md) | Unix API MCP → Telegram |
| [docs/schedules.md](docs/schedules.md) | Delayed/recurring jobs |
| [docs/skills.md](docs/skills.md) | Bundled skills |
| [docs/oauth.md](docs/oauth.md) | Remote MCP OAuth |
| [docs/configuration.md](docs/configuration.md) | Env reference |
| [website/](website/) | Landing page for acpbot.app |

---

## Project layout

```text
src/
  main.ts           Telegram worker entry
  acp-host/         Long-lived agent owner + schedule ticker + OAuth HTTP
  acp/              Thin ACP session host (SDK client)
  core/             Daemon, commands, media, worker API
  mcp/              Host MCP, repo MCP, OAuth
  env/              Ports (telegram, agents, store, speech)
  schedules/        In-repo schedule store
docker/             Container entrypoint
website/            acpbot.app static site
test/               bun test suite
skills/             Bundled agent skills
docs/               Operator docs
```

---

## Development

```bash
bun install
TACP_SKIP_LIVE_ACP=1 bun test ./test
bun run typecheck
bun run build:compile
bun run acp-host
bun run start
```

One seam: the `Environment` port (`telegram`, `agents`, `clock`, `store`). Core stays pure; fakes under `src/env/` for tests.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute. **No warranty; no liability for damages.** See the [Disclaimer](#disclaimer--use-at-your-own-risk) above.
