# Configuration reference

All values come from process env (or a JSON config object in tests).  
Nothing assumes a fixed host path or TTY. Source of truth for comments: `.env.example`.

## Required (real Telegram run)

| Variable | Purpose |
|---|---|
| `TACP_BOT_TOKEN` | Bot token from @BotFather (alias: `BOT_TOKEN`) |
| `TACP_OPERATOR_USER_ID` | Allowlisted Telegram user id (alias: `OPERATOR_USER_ID`) |
| `TACP_STORE_PATH` | Durable tacp JSON store file path |
| `TACP_ACPX_STATE_DIR` | Host state directory — **prefer absolute** |

`TACP_ACPX_STATE_DIR` holds:

- ACP session records: `sessions/<sessionKey>.json`
- OAuth tokens / pending PKCE: `mcp-oauth/`
- Sockets: `worker-api.sock`, `acp-host.sock`

Keep it private (owner-only). Default `data/` is gitignored.

## Repos & schedules

| Variable | Purpose |
|---|---|
| `TACP_REPOS_JSON` | `{"repoKey":"/absolute/cwd",…}` — `/new` picker + acp-host schedule scan |
| `TACP_SCHEDULE_TICK_MS` | Schedule scan interval (default `20000`) |

Quote the JSON value in `.env` so shells/dotenv keep it intact.

## Agent backend

| Variable | Purpose |
|---|---|
| `TACP_AGENT_BACKEND` | `real` (ACP) or `echo` / `fake` (no agent process) |
| `TACP_DEFAULT_AGENT` | Default agent id (`grok-build`, `claude`, `codex`, `opencode`, …) |
| `TACP_AGENT_COMMAND_JSON` | Spawn overrides: `{"id":{"command":"…","args":[…]}}` |

Grok without cached login:

```bash
XAI_API_KEY=…
```

## acp-host

| Variable | Purpose |
|---|---|
| `TACP_ACP_HOST` | `1` force attach; `0` force in-process; default auto if socket exists |
| `TACP_ACP_HOST_SOCK` | Override host socket path |

```bash
# Terminal 1
bun run acp-host

# Terminal 2
TACP_ACP_HOST=1 bun run start
```

## Operator chat

| Variable | Purpose |
|---|---|
| `TACP_OPERATOR_CHAT_ID` | Optional fixed private chat id |

## Skills

| Variable | Purpose |
|---|---|
| `TACP_SKILL_ROOTS` | Extra skill dirs, colon/semicolon/comma-separated |

Defaults (when `HOME` is known): `~/.grok/skills`, `~/.grok/bundled/skills`, `~/.agents/skills`, `~/.claude/skills`.

## Media & speech

| Variable | Purpose |
|---|---|
| `ELEVENLABS_API_KEY` | Preferred STT/TTS |
| `ELEVENLABS_VOICE_ID` | TTS voice |
| `ELEVENLABS_TTS_MODEL` | default `eleven_multilingual_v2` |
| `ELEVENLABS_STT_MODEL` | default `scribe_v1` |
| `ELEVENLABS_BASE_URL` | default `https://api.elevenlabs.io` |
| `OPENAI_API_KEY` | Whisper STT fallback; OpenAI TTS only if no ElevenLabs |
| `TACP_OPENAI_BASE_URL` | default `https://api.openai.com/v1` |
| `TACP_STT` | `1` on (default when a key is set), `0` off |
| `TACP_TTS_MODE` | `agent` (default) \| `always` \| `off` |
| `TACP_MCP` | `1` host MCP on (default), `0` disable |
| `TACP_ACP_MEDIA_ATTACHMENTS` | `1` send images/audio as ACP content blocks (default off — many agents lack `promptCapabilities.image`; media goes to `.tacp-inbox/`) |
| `TACP_WORKER_API_SOCK` | Override worker Unix socket path |

## Remote MCP OAuth

| Variable | Purpose |
|---|---|
| `TACP_OAUTH_CALLBACK_BASE` | URL the **phone browser** can reach (Tailscale Serve recommended) |
| `TACP_OAUTH_LISTEN_HOST` | default `0.0.0.0` |
| `TACP_OAUTH_LISTEN_PORT` | default `8788` |

No per-gateway `CLIENT_ID` / `AUTH_URL` env vars — discovery + DCR only. See [oauth.md](oauth.md).

## Logging

| Variable | Purpose |
|---|---|
| `TACP_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `TACP_VERBOSE` | `1` → debug |

## Minimal examples

### Echo (Telegram only)

```bash
TACP_BOT_TOKEN=…
TACP_OPERATOR_USER_ID=…
TACP_STORE_PATH=./data/tacp-store.json
TACP_ACPX_STATE_DIR=/abs/path/data/acpx-state
TACP_REPOS_JSON='{"demo":"/abs/path/demo"}'
TACP_AGENT_BACKEND=echo
```

### Real Grok + host

```bash
TACP_BOT_TOKEN=…
TACP_OPERATOR_USER_ID=…
TACP_STORE_PATH=./data/tacp-store.json
TACP_ACPX_STATE_DIR=/abs/path/data/acpx-state
TACP_REPOS_JSON='{"demo":"/abs/path/demo","tacp":"/abs/path"}'
TACP_AGENT_BACKEND=real
TACP_DEFAULT_AGENT=grok-build
# XAI_API_KEY=…   # if needed
```

```bash
bun run acp-host
TACP_ACP_HOST=1 bun run start
```
