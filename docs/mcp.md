# MCP in tacp

tacp injects MCP servers into each ACP session on ensure / `session/new`:

1. **Per-repo** servers from `<repo>/.tacp/mcp.json` (optional profile filter)
2. **Built-in** server named **`tacp`** (host tools: speak, Telegram send, schedules)

The name `tacp` is reserved.

## Built-in host tools (server `tacp`)

| Tool | Purpose |
|---|---|
| `speak` | TTS → voice note in the topic (via worker API) |
| `update` / `telegram_send` | Mid-turn text to the topic |
| `telegram_send_photo` | Send an image path under the session repo |
| `telegram_send_file` | Send a document path under the session repo |
| `schedule_create` | Durable job under `.tacp/schedules/` |
| `schedule_list` | List jobs for session (or whole repo) |
| `schedule_cancel` | Soft-disable a job |
| `schedule_run_now` | Set `nextRunAt=now` for next host tick |

Outbound Telegram tools **never** see the bot token. They POST to the worker Unix API — [worker-api.md](worker-api.md).

Disable host MCP entirely:

```bash
TACP_MCP=0
```

## Per-repo MCP (`.tacp/mcp.json`)

Each session’s **cwd** (repo root) may declare:

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

### Path resolution

- Relative path-like tokens (`./…`, `.tacp/…`) resolve from the **repo root**
- `..` escapes outside the repo are rejected
- Absolute paths are allowed (system / shared tools)
- npm specs (`@scope/pkg`), flags, and bare binaries are left unchanged
- Containment is **lexical** (no symlink follow for the escape check)
- Injected env: `TACP_SESSION_KEY`, `TACP_REPO_ROOT`, `TACP_STATE_DIR`

Missing or invalid JSON → built-in only (warn on invalid).

Also see `demo/.tacp/mcp.json` / `demo/.tacp/mcp.json.example` if present.

### Remote servers (HTTP / SSE)

Registered via topic commands (persisted in the repo registry, **not** tokens):

```text
/mcp add linear https://mcp.example/…
/mcp status
/mcp remove linear
/mcp auth linear
```

OAuth: [oauth.md](oauth.md).

## MCP profiles

When a repo has more servers than a workflow needs, filter by profile.

**Today `mcpProfile` is repo-global** — every session in that repo shares the filter. Per-topic selection is not wired yet (build path accepts an override for tests / future hooks).

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

| Case | Result |
|---|---|
| Profile set **and** key exists | Filter repo MCP to that name list, then merge built-in `tacp` |
| Empty list `[]` | No repo MCP; `tacp` still added |
| Allowlist name missing from `mcp.json` | Ignored |
| Missing / unknown / unreadable config | **Fail-open**: no filter (all servers). Warn when a profile was requested but not applied |

`defaultAgent` in config is read for future per-repo defaults; session create still uses global `TACP_DEFAULT_AGENT` today.

## Merge order

1. Repo servers (after optional profile filter)
2. Built-in `tacp` host server

## Related

- [schedules.md](schedules.md) — schedule tools + host fire
- [worker-api.md](worker-api.md) — Telegram outbound
- [oauth.md](oauth.md) — remote auth
