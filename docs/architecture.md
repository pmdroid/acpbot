# Architecture

## Goals

1. **Telegram is the UI** — one private chat, one topic per agent session
2. **ACP is the agent wire** — official TypeScript SDK, stdio spawn
3. **Testable core** — pure daemon behind an `Environment` port
4. **Safe process boundaries** — agent children never hold the bot token

## Processes

```text
┌─────────────────────────────────────────────────────────────┐
│  Telegram (Bot API, long poll)                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  acpbot worker  (acpbot worker / bun run start)                 │
│  · config.toml (TOML-first)                                 │
│  · allowlist operator                                       │
│  · lobby + topic command routing                            │
│  · session store (store_path)                               │
│  · worker-api.sock  (HTTP over Unix — outbound media)       │
│  · always talks to acp-host.sock (required)                 │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                │  worker → acp-host          │  MCP tools POST
                ▼                             ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│  acp-host (required)         │   │  Host MCP (stdio child)  │
│  · owns agent stdio slots    │   │  speak / telegram_* /    │
│  · schedule ticker           │   │  schedule_*              │
│  · GET /oauth/callback       │   │  → worker-api.sock       │
└───────────────┬──────────────┘   └──────────────────────────┘
                │
                ▼
┌──────────────────────────────┐
│  Agent process (ACP stdio)   │
│  grok | claude-adapter | …   │
└──────────────────────────────┘
```

### Worker (`src/main.ts` → `src/core/daemon.ts`)

- Long-polls `getUpdates`
- Maps chat + `message_thread_id` → session
- Slash commands never forward to the agent
- Buffers agent text during a turn; flushes at end (Telegram chunk limits)
- Serves **worker API** on `$state_dir/worker-api.sock`

### ACP session host (`src/acp/`)

Thin client over `@agentclientprotocol/sdk`:

- `session/new` / `session/load`
- `prompt`, permissions, elicitation, `_x.ai/ask_user_question`
- Client `fs/*` + `terminal/*` (process-group aware terminal manager)
- Injects MCP servers (repo + built-in `acpbot`)
- Model / config options for `/model`

### acp-host (`src/acp-host/`, required)

Long-lived process that **owns agent stdio** so the Telegram worker can restart without killing agents. The worker fails boot if the host socket is missing. Also:

- Scans each `[repos]` entry for due schedules
- Serves OAuth callback HTTP when `[oauth].callback_base` is set

Socket: `$state_dir/acp-host.sock`  

### Background install (`acpbot setup`)

The guided setup can install **both** host and worker as user services (same
`config.toml`):

| | macOS LaunchAgent | Linux systemd user |
|---|---|---|
| Host | `app.acpbot.host` (`acpbot host`) | `acpbot-host.service` |
| Worker | `app.acpbot.worker` | `acpbot.service` |

See [configuration.md](configuration.md#background-services-host--worker).

## Environment port

```text
src/core/     pure daemon logic
src/env/      ports + fakes + real telegram / agents / speech / store
```

`Environment` bundles `telegram`, `agents`, `clock`, `store` (and speech when configured). Acceptance tests run against fakes (`fakeTelegram`, `echoAgents`, …); production wires `realTelegram` + `realAgents`.

## On-disk layout

| Path | Contents |
|---|---|
| `~/.config/acpbot/config.toml` | Primary process config (TOML) |
| `store_path` (default `~/.local/share/acpbot/store.json`) | Durable acpbot JSON (sessions registry, offsets, …) |
| `$state_dir/sessions/` | ACP session records (for `session/load`) |
| `$state_dir/worker-api.sock` | Outbound worker HTTP API |
| `$state_dir/acp-host.sock` | Required host control socket |
| `$state_dir/mcp-oauth/` | Pending PKCE + tokens (mode `0600`) |
| `<repo>/.acpbot/mcp.json` | Per-repo MCP servers |
| `<repo>/.acpbot/config.json` | Optional repo defaults / `mcpProfile` |
| `<repo>/.acpbot/schedules/` | Durable schedule jobs |
| `<repo>/.acpbot-inbox/` | Inbound media drop (per workspace; ignore in that repo if you use git) |

Default `state_dir` is `~/.local/share/acpbot/state` (absolute after load). Worker and acp-host must share the same config / `state_dir`.

## Session model

1. Lobby `/new` → pick repo (+ name) → create forum topic (stable title `⏸ repo/name`)
2. Topic messages become ACP `prompt` turns (with optional media prep)
3. Permissions / questions → inline keyboards; answers complete the RPC
4. `/agent` may respawn a different process for the same topic
5. `/model` uses ACP `session/set_model` or config options when available

**Topic titles are not rewritten for turn status.** Live status lives in a single in-topic **working bubble** (see below).

## Turn UX (working bubble)

While a turn is in flight the worker posts **one** message in the topic and keeps it current:

| State | Bubble text (examples) |
|---|---|
| Turn running | `⏳ Working…` |
| MCP `update` | `⏳ …` (edits the same message) |
| Permission / question | `❓ Waiting for your decision…` |
| Turn ends / cancel / fail | Bubble **deleted**, then final reply or error |

- Multi-topic / multi-agent safe: status is always **in that session’s thread**, not a chat-level typing indicator
- `telegram_send` / photo / file / speak still create **separate** permanent messages
- Session status is still tracked in the store for `/status` and steer vs prompt; only the **Telegram topic name** stays fixed

## Operator prompt queue

Per-session FIFO in the **worker** (not host-only):

| Input while turn busy | Behavior |
|---|---|
| Free-text / media | Enqueued; ack with **Remove**; runs after turn end |
| `/steer <text>` | Abort in-flight turn (queue kept), start steer turn immediately |
| `/cancel` | Abort + **clear** queue |

Host `promptQueue` (acp-host) remains a separate serialization for concurrent host clients. Operator UX is owned by the worker queue. Details: [commands.md](commands.md#queue-vs-steer-while-a-turn-is-busy).

## Message volume policy

**Buffer agent text during the turn, flush once at the end**, chunked to Telegram limits. Mid-turn pings use explicit MCP tools (`update` → edit working bubble — **preferred progress channel**; `telegram_send`, photo, file, speak → new messages) via the worker API instead of streaming every token.

## Security notes

- Single-operator allowlist via CLI pairing (`acpbot pair approve`; state under `$state_dir/pairing/`)
- Bot token only in the worker process
- Repo path containment for photo/file tools ([worker-api.md](worker-api.md))
- OAuth tokens never written under the repo tree
- OAuth HTTP listen defaults to `0.0.0.0` when enabled — prefer Tailscale Serve; protection is high-entropy `state` + PKCE
