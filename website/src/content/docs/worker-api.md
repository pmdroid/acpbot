---
title: Worker API
description: Unix HTTP API from MCP tools to Telegram.
order: 13
section: reference
---

MCP tools run inside (or beside) the agent process and **must not** hold the Telegram bot token. They call the acpbot **worker** over HTTP on a Unix socket; the worker owns the token and session → topic map.

## Socket

| | |
|---|---|
| Default path | `$state_dir/worker-api.sock` (from `config.toml` / `state_dir`) |
| Override | `ACPBOT_WORKER_API_SOCK` (absolute preferred) |
| Server | Worker daemon (`src/core/worker-api-server.ts`) |
| Client | Host MCP (`src/mcp/worker-api.ts`) |

Boot log includes something like:

```text
acpbot worker API: unix:///…/worker-api.sock
```

## Endpoints (HTTP over Unix)

All bodies are JSON. Responses are JSON `{ ok: true, … }` or `{ ok: false, error: "…" }`.

| Method / path | Body | Effect |
|---|---|---|
| `POST /v1/telegram/message` | `sessionKey`, `text`, optional `kind` (`update` \| `message`) | `kind=update` → edit (or create) the live **working bubble**; `kind=message` → new permanent message |
| `POST /v1/telegram/photo` | `sessionKey`, `path`, optional `caption`, `filename` | `sendPhoto` |
| `POST /v1/telegram/document` | `sessionKey`, `path`, optional `caption`, `filename` | `sendDocument` |
| `POST /v1/telegram/speak` | `sessionKey`, `text` | TTS + `sendVoice` |
| `POST /v1/review/run` | `sessionKey`, optional `mode`, `protocol`, `agent_a`, `agent_b`, `base`, `max_priority` | Dual-agent closeout review — [Review](/docs/review) |
| `GET /v1/health` | — | Liveness |

Exact path strings are defined in `src/mcp/worker-api.ts` / the server; MCP tool wrappers hide them from agents.

The working bubble is owned by the worker (posted at turn start, deleted at turn end). Topic forum titles are **not** renamed for status — see [Architecture](/docs/architecture#turn-ux-working-bubble).

## Path safety (photo / file)

Agent-supplied paths are resolved with `resolvePathUnderRepo` (`src/mcp/repo-path.ts`):

- Relative paths join under the session **repo root**
- Absolute paths allowed only if they stay inside the repo after `realpath`
- `..` escapes rejected
- Missing files fail with a clear error (containment still enforced on the candidate path)

## Delivery path

MCP tools call this API **directly** (HTTP over the Unix socket). There is no disk queue.

On worker start, any leftover pre-API dirs under the state directory
(`telegram-queue/`, `speak-queue/`) are **removed** once so stale `.req.json`
jobs do not hang forever.

Start the API by starting the worker:

```bash
acpbot              # binary
# or from source: acpbot worker
# logs: acpbot worker API: unix://…/worker-api.sock
```

Tests: `test/worker-api.test.ts`.

## Speech modes

Controlled in `config.toml` (see [Configuration](/docs/configuration#speech-tts--stt-providers)):

| `features.tts_mode` | Behavior |
|---|---|
| `agent` (default) | Only when the model calls MCP `speak` |
| `always` | TTS more aggressively on agent text |
| `off` | No TTS |

| `speech.tts_provider` / `stt_provider` | API used |
|---|---|
| `auto` (default) | ElevenLabs if keyed, else OpenAI |
| `openai` | OpenAI Whisper / TTS (first-class) |
| `elevenlabs` | ElevenLabs Scribe / TTS |
| `off` | That side disabled |

TTS and STT providers are independent (e.g. OpenAI TTS + ElevenLabs STT).

## Why not put the token in MCP env?

- Agent process escape would leak bot credentials
- Session → topic resolution needs the live daemon store
- Worker restart / reattach stays coherent if only the worker speaks Bot API
