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
│  tacp worker  (bun run start / src/main.ts)                 │
│  · allowlist operator                                       │
│  · lobby + topic command routing                            │
│  · session store (TACP_STORE_PATH)                          │
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
- Serves **worker API** on `$TACP_ACPX_STATE_DIR/worker-api.sock`

### ACP session host (`src/acp/`)

Thin client over `@agentclientprotocol/sdk`:

- `session/new` / `session/load`
- `prompt`, permissions, elicitation, `_x.ai/ask_user_question`
- Client `fs/*` + `terminal/*` (process-group aware terminal manager)
- Injects MCP servers (repo + built-in `tacp`)
- Model / config options for `/model`

### acp-host (`src/acp-host/`, required)

Long-lived process that **owns agent stdio** so the Telegram worker can restart without killing agents. The worker fails boot if the host socket is missing. Also:

- Scans each `TACP_REPOS_JSON` repo for due schedules
- Serves OAuth callback HTTP when `TACP_OAUTH_CALLBACK_BASE` is set

Socket: `$TACP_ACPX_STATE_DIR/acp-host.sock`  
Design note: [ideas/agent-host-keepalive.md](ideas/agent-host-keepalive.md).

## Environment port

```text
src/core/     pure daemon logic
src/env/      ports + fakes + real telegram / agents / speech / store
```

`Environment` bundles `telegram`, `agents`, `clock`, `store` (and speech when configured). Acceptance tests run against fakes (`fakeTelegram`, `echoAgents`, …); production wires `realTelegram` + `realAgents`.

## On-disk layout

| Path | Contents |
|---|---|
| `TACP_STORE_PATH` | Durable tacp JSON (sessions registry, offsets, …) |
| `$TACP_ACPX_STATE_DIR/sessions/` | ACP session records (for `session/load`) |
| `$TACP_ACPX_STATE_DIR/worker-api.sock` | Outbound worker HTTP API |
| `$TACP_ACPX_STATE_DIR/acp-host.sock` | Optional host control socket |
| `$TACP_ACPX_STATE_DIR/mcp-oauth/` | Pending PKCE + tokens (mode `0600`) |
| `<repo>/.tacp/mcp.json` | Per-repo MCP servers |
| `<repo>/.tacp/config.json` | Optional repo defaults / `mcpProfile` |
| `<repo>/.tacp/schedules/` | Durable schedule jobs |
| `<repo>/.tacp-inbox/` | Inbound media drop (gitignored pattern) |

**Always use an absolute `TACP_ACPX_STATE_DIR`** when running worker + acp-host together so OAuth pending state and sockets agree regardless of CWD.

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

## Message volume policy

**Buffer agent text during the turn, flush once at the end**, chunked to Telegram limits. Mid-turn pings use explicit MCP tools (`update` → edit working bubble; `telegram_send`, photo, file, speak → new messages) via the worker API instead of streaming every token.

## Security notes

- Single-operator allowlist (`TACP_OPERATOR_USER_ID`)
- Bot token only in the worker process
- Repo path containment for photo/file tools ([worker-api.md](worker-api.md))
- OAuth tokens never written under the repo tree
- OAuth HTTP listen defaults to `0.0.0.0` when enabled — prefer Tailscale Serve; protection is high-entropy `state` + PKCE
