# Worker outbound API

MCP tools run inside (or beside) the agent process and **must not** hold the Telegram bot token. They call the tacp **worker** over HTTP on a Unix socket; the worker owns the token and session → topic map.

## Socket

| | |
|---|---|
| Default path | `$TACP_ACPX_STATE_DIR/worker-api.sock` |
| Override | `TACP_WORKER_API_SOCK` (absolute path preferred) |
| Server | Worker daemon (`src/core/worker-api-server.ts`) |
| Client | Host MCP (`src/mcp/worker-api.ts`) |

Boot log includes something like:

```text
tacp worker API: unix:///…/worker-api.sock
```

## Endpoints (HTTP over Unix)

All bodies are JSON. Responses are JSON `{ ok: true, … }` or `{ ok: false, error: "…" }`.

| Method / path | Body | Effect |
|---|---|---|
| `POST /telegram/message` | `sessionKey`, `text`, optional `kind` (`update` \| `message`) | Send text to the session topic |
| `POST /telegram/photo` | `sessionKey`, `path`, optional `caption`, `filename` | `sendPhoto` |
| `POST /telegram/document` | `sessionKey`, `path`, optional `caption`, `filename` | `sendDocument` |
| `POST /telegram/speak` | `sessionKey`, `text` | TTS + `sendVoice` |

Exact path strings are defined in `src/mcp/worker-api.ts` / the server; MCP tool wrappers hide them from agents.

## Path safety (photo / file)

Agent-supplied paths are resolved with `resolvePathUnderRepo` (`src/mcp/repo-path.ts`):

- Relative paths join under the session **repo root**
- Absolute paths allowed only if they stay inside the repo after `realpath`
- `..` escapes rejected
- Missing files fail with a clear error (containment still enforced on the candidate path)

## Queues

Some tools may enqueue durable jobs under the state dir (telegram-queue / speak-queue) so delivery can be acked and retried. Photo/document jobs require a path. See `src/mcp/telegram-queue.ts` and tests in `test/telegram-queue.test.ts`, `test/worker-api.test.ts`.

## Speech modes

Controlled by env (see [configuration.md](configuration.md)):

| `TACP_TTS_MODE` | Behavior |
|---|---|
| `agent` (default) | Only when the model calls MCP `speak` (or legacy `<<<speak>>>` marker) |
| `always` | TTS more aggressively on agent text |
| `off` | No TTS |

Providers: ElevenLabs preferred; OpenAI TTS only if ElevenLabs is not configured.

## Why not put the token in MCP env?

- Agent process escape would leak bot credentials
- Session → topic resolution needs the live daemon store
- Worker restart / reattach stays coherent if only the worker speaks Bot API
