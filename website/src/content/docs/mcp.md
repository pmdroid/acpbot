---
title: MCP
description: Built-in acpbot tools, per-repo servers, profiles.
order: 12
section: reference
---

acpbot injects MCP servers into each ACP session on ensure / `session/new`:

1. **Per-repo** servers from `<repo>/.acpbot/mcp.json` (optional profile filter)
2. **Built-in** server named **`acpbot`** (host tools: speak, Telegram send, schedules)

The name `acpbot` is reserved.

## Built-in host tools (server `acpbot`)

| Tool | Purpose |
|---|---|
| `speak` | TTS → voice note in the topic |
| **`update`** | **Primary mid-turn progress channel** — edits the live **working bubble** (`⏳ …`), not a new spam message |
| `telegram_send` | Permanent mid-turn text (not the working bubble) |
| `telegram_send_photo` | Image under the session repo |
| `telegram_send_file` | Document under the session repo |
| `schedule_create` | Create a delayed / recurring job |
| `schedule_list` | List jobs for this session (or whole repo) |
| `schedule_cancel` | Disable a job |
| `schedule_run_now` | Mark due so the host fires on the next tick |
| `agent_spawn` / `list` / `send` / `wait` / `kill` | Multi-agent children (worktrees + A2A) — [Multi-agent](/docs/multi-agent) |
| `review_run` | Dual-agent closeout review (frozen bundle) — [Review](/docs/review) |
| `linear_get_binding` / `linear_bind_project` / `linear_unbind_project` | Topic ↔ Linear project binding — [Linear](/docs/linear) |

### Working bubble vs permanent messages

- On turn start the worker posts `⏳ Working…` in the topic.
- **`update` is the default progress tool.** Call it after major steps, long waits, or plan changes so the operator sees progress without waiting for the final reply. Prefer short 1–3 sentence pings; do not dump the final answer into `update`, and do not call on every tiny tool step.
- When the turn needs the operator (permission / question), the bubble becomes `❓ Waiting for…`.
- When the turn ends, the worker **deletes** the bubble, then delivers the final assistant reply.
- Use **`telegram_send`** for content that should stay in the chat history (links, intermediate results).

Agent-facing habit text lives in the bundled **telegram** skill (`skills/telegram/SKILL.md`).

Outbound Telegram tools **never** see the bot token. They POST to the worker Unix API — [Worker API](/docs/worker-api).

Agent guidance for these tools is in bundled skills **telegram**, **schedules**, **multi-agent**, and **linear** ([Skills](/docs/skills)).

Disable host MCP entirely:

```toml
[features]
mcp = false
```

(Env override: `ACPBOT_MCP=0`.)

## Remote OAuth MCP → per-slot stdio proxy

Agents (especially **Grok**) mishandle remote OAuth MCP. acpbot **always** proxies remotes via the **official MCP TypeScript SDK** (`@modelcontextprotocol/client` + `@modelcontextprotocol/server`):

```text
Agent (one process per topic/slot)
  └── stdio ──►  acpbot mcp-proxy   (McpServer + StdioServerTransport)
                    └── Client + StreamableHTTPClientTransport
                         └── HTTP + Bearer ──►  remote gateway
```

- **Per slot:** each topic session (`repo/name`) gets its own agent + its own `mcp-proxy` children. Slots do not share proxy processes.
- OAuth tokens stay on the host (`/mcp auth`); the proxy’s `AuthProvider` re-reads the store every request and force-refreshes on 401.
- The agent only sees a normal **stdio** server (named like the gateway id, e.g. `full`).
- **Always attached:** remotes start as `mcp-proxy` at session spawn (and on `/mcp add`). Until OAuth, the proxy advertises an **empty tool list**.
- **After `/mcp auth`:** the live proxy connects, registers tools, and sends `tools/list_changed` — **no agent restart**.
- **Reauth** / token refresh / session drop: proxy reconnects upstream — **no agent restart**.

### Why empty tools first?

stdio MCP children are fixed when the agent process is spawned. Starting the proxy **before** auth means:

1. `/mcp add` (or session start with remotes in `.acpbot/mcp.json`) always attaches the proxy.
2. `/mcp auth` only stores a token; the running proxy connects and lists tools.
3. Reauth never needs another agent respawn.

If you add a remote while a topic is already live, acpbot force-respawns **once** so the new stdio child appears; later auth does not.

## Per-repo MCP (`.acpbot/mcp.json`)

Each session’s **cwd** (repo root) may declare:

```json
{
  "mcpServers": [
    {
      "name": "local-tools",
      "command": "bun",
      "args": ["run", ".acpbot/tools/server.ts"],
      "env": { "FOO": "bar" }
    }
  ]
}
```

### Path resolution

- Relative path-like tokens (`./…`, `.acpbot/…`) resolve from the **repo root**
- `..` escapes outside the repo are rejected
- Absolute paths are allowed (system / shared tools)
- npm specs (`@scope/pkg`), flags, and bare binaries are left unchanged
- Containment is **lexical** (no symlink follow for the escape check)
- Injected env into MCP children: `ACPBOT_SESSION_KEY`, `ACPBOT_REPO_ROOT`, `ACPBOT_REPO_STATE_DIR` (per-repo config tree; not host `ACPBOT_STATE_DIR`)

Missing or invalid JSON → built-in only (warn on invalid).

### Remote servers (HTTP / SSE)

Register via topic commands (persisted in the repo registry, **not** tokens):

```text
/mcp add linear https://mcp.example/…
/mcp status
/mcp remove linear
/mcp auth linear
```

OAuth: [OAuth](/docs/oauth).

## MCP profiles

When a repo has more servers than a workflow needs, filter by profile.

**Today `mcpProfile` is repo-global** — every session in that repo shares the filter. Per-topic selection is not wired yet (build path accepts an override for tests / future hooks).

`<repo>/.acpbot/config.json`:

```json
{
  "defaultAgent": "grok-build",
  "mcpProfile": "automation"
}
```

`<repo>/.acpbot/mcp.profiles.json`:

```json
{
  "automation": ["schedule", "homeassistant"],
  "coding": []
}
```

Rules:

| Case | Result |
|---|---|
| Profile set **and** key exists | Filter repo MCP to that name list, then merge built-in `acpbot` |
| Empty list `[]` | No repo MCP; `acpbot` still added |
| Allowlist name missing from `mcp.json` | Ignored |
| Missing / unknown / unreadable config | **Fail-open**: no filter (all servers). Warn when a profile was requested but not applied |

`defaultAgent` in per-repo config is read for future defaults; session create still uses global `default_agent` from `config.toml` today.

## Merge order

1. Repo servers (after optional profile filter)
2. Built-in `acpbot` host server

## Related

- [Schedules](/docs/schedules) — schedule tools + host fire
- [Worker API](/docs/worker-api) — Telegram outbound
- [OAuth](/docs/oauth) — remote auth
