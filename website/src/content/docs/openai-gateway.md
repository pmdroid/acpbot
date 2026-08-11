---
title: OpenAI gateway
description: Host HTTP API for LibreChat / Open WebUI — /v1/models and chat completions.
order: 26
section: start
---

The **OpenAI-compatible gateway** runs **inside `acpbot host`** and maps Chat Completions onto real acp-host agent slots (same ensure/prompt path as Telegram and `acpbot chat`).

```text
LibreChat / Open WebUI
        │  Bearer token
        │  GET  /v1/models
        │  POST /v1/chat/completions
        ▼
  acpbot host · openai gateway (:8791)
        │
        ▼
  acp-host slots (repo cwd + tools + MCP)
```

## Enable

In `config.toml`:

```toml
[openai_gateway]
enabled = true
listen_host = "127.0.0.1"
listen_port = 8791
token = "env:ACPBOT_OPENAI_GATEWAY_TOKEN"
# default_repo = "demo"
# permission_mode = "bypass"
```

```bash
export ACPBOT_OPENAI_GATEWAY_TOKEN="your-secret"
acpbot restart --host   # or start host
curl -sS -H "Authorization: Bearer $ACPBOT_OPENAI_GATEWAY_TOKEN" \
  http://127.0.0.1:8791/v1/models
```

## Models

| Model id | Session |
|---|---|
| `acpbot/<repo>/<agent>` | `repo/main` with agent |
| `acpbot/<repo>/<agent>/<name>` | `repo/name` |
| `acpbot/<agent>` | `default_repo/main` (requires `default_repo`) |

Only repos from `[repos]` (and optional `openai_gateway.repos` allowlist) appear in `/v1/models`.

## Completions

- Uses the **latest user message only** (ACP keeps history in the slot; do not replay full `messages[]`).
- `stream: true` (default): SSE `choices[0].delta.content` + `data: [DONE]`
- `stream: false`: single JSON completion
- Disconnect / abort cancels the host turn
- Default **permission_mode = bypass** (coding agent on a local port — keep bind on localhost)

## Open WebUI

1. Admin → Connections → OpenAI  
2. URL: `http://127.0.0.1:8791/v1`  
3. API key: gateway token  
4. Select model `acpbot/…`

## LibreChat

Custom endpoint `baseURL: http://127.0.0.1:8791/v1` with the same Bearer token; model list from `/v1/models` or a static allowlist.

## Security

- Default bind **127.0.0.1** only  
- Token required on every route except `/health`  
- Tool **bypass** means the agent can run shell/tools without a human click — same as Telegram `/permissions bypass`  
- Expose only via Tailscale / SSH tunnel if remote UIs need access  

## Related

- [CLI chat hub](/docs/cli-chat) — same host slots, TTY focus model  
- [Architecture](/docs/architecture) — host process boundary  
