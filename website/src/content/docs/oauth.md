---
title: OAuth
description: Remote MCP auth with PKCE and DCR.
order: 16
section: advanced
---

Set `[oauth].callback_base` in `config.toml` so acp-host can complete browser OAuth.  
Public remotes work without it; authenticated gateways need the callback (or `/mcp code` paste).

Tokens are **never** written to the repo. They live under:

```text
$state_dir/mcp-oauth/by-repo/<repoKey>/<id>.json   # mode 0600
$state_dir/mcp-oauth/pending/                      # PKCE in flight
```

Default `state_dir` is `~/.local/share/acpbot/state` (see [Configuration](/docs/configuration)).

## Shared state dir

`/mcp auth` runs in the **Telegram worker** and writes pending PKCE.  
`GET /oauth/callback` and session ensure run on **acp-host**.

Both processes **must** use the **same config file** (or the same absolute `state_dir`). Boot logs print the resolved path on both processes.

## Setup

### Recommended: Tailscale MagicDNS HTTPS

Listener always uses port **8788**. Selecting MagicDNS only switches the scheme to
**https** and loads Tailscale certs — it does **not** bind :443.

```toml
[oauth]
callback_base = "https://mac-mini.taile07e4.ts.net:8788"   # phone on the same tailnet
# listen_port = 8788   # default (same for http and https)
# tls_cert / tls_key optional — auto-detected from ~/.local/share/tailscale-certs/
```

Issue a cert once (macOS and Linux — same paths):

```bash
mkdir -p ~/.local/share/tailscale-certs
cd ~/.local/share/tailscale-certs
tailscale cert mac-mini.taile07e4.ts.net
```

| File | Path |
|------|------|
| **Certificate** | `~/.local/share/tailscale-certs/<MagicDNS>.crt` |
| **Private key** | `~/.local/share/tailscale-certs/<MagicDNS>.key` |

`acpbot` auto-detects those files from `callback_base` (or `tailscale status`).  
You can also set them explicitly:

```toml
[oauth]
callback_base = "https://mac-mini.taile07e4.ts.net:8788"
tls_cert = "/Users/you/.local/share/tailscale-certs/mac-mini.taile07e4.ts.net.crt"
tls_key  = "/Users/you/.local/share/tailscale-certs/mac-mini.taile07e4.ts.net.key"
```

### Plain HTTP fallback

```toml
[oauth]
callback_base = "http://100.x.y.z:8788"   # Tailscale IP or LAN — no cert needed
# listen_host = "0.0.0.0"
# listen_port = 8788
```

### Guided setup detection

`acpbot setup` offers a picker for `callback_base`. It **detects** hosts when possible
(via `tailscale status --json` and local network interfaces) and always allows a custom URL:

| Option | Source | Example |
|--------|--------|---------|
| **Tailscale HTTPS** | `Self.DNSName` (MagicDNS) + local certs | `https://mac-mini.taile07e4.ts.net:8788` |
| **Tailscale IP** | Tailscale `100.x` IPv4 | `http://100.114.193.89:8788` |
| **LAN IP** | Private interface addrs (`10.x`, `172.16–31.x`, `192.168.x`) | `http://192.168.1.10:8788` |
| **Custom URL…** | Manual entry | tunnel / Serve / Funnel |
| **Skip / clear** | Unset | use `/mcp code` paste fallback |

- All options use port **8788**. MagicDNS is **`https://…:8788`** (TLS); IP options stay **`http://…:8788`**.
- If certs are missing, setup prints the `tailscale cert` commands (table of `.crt` / `.key` paths).
- Prefer **Tailscale HTTPS** when the phone is on the same tailnet. LAN IPs only work on the same Wi‑Fi/Ethernet.
- Detection + cert helpers: `src/setup/oauth-callback-detect.ts` (tests in `test/oauth-callback-detect.test.ts`).

Run:

```bash
acpbot host      # serves GET /oauth/callback when callback_base is set
acpbot worker    # same config.toml / state_dir
# from source: bun run acp-host · bun run start
```

If bind fails (port in use), **acp-host exits** with a clear error when `callback_base` is set. Free the port or use the paste fallback below.

## Operator flow

1. In a session topic: `/mcp add <id> <url>`
2. `/mcp auth <id>`
3. Open the **tappable authorize URL** in Telegram (host does not open a browser)
4. On callback, PKCE completes; Bearer tokens merge into remote MCP at ensure
5. Pending PKCE expires after **15 minutes**

When `callback_base` is set, ensure **fail-closes** if a remote MCP has no token:

```text
MCP "<id>" has no OAuth token; run /mcp auth <id>
```

### Paste fallback

If the redirect cannot reach the host:

1. Prefer `/mcp code <full-callback-url>` (includes `code` + `state`)
2. Last resort: `/mcp code <code> <id>`

## Discovery (no env client_id / auth URL)

On `/mcp auth`, acpbot:

1. Probes the MCP URL for `WWW-Authenticate` `resource_metadata` (RFC 9728), else fetches `/.well-known/oauth-protected-resource…`
2. Loads authorization-server metadata (RFC 8414)
3. Dynamically registers a public PKCE client (`registration_endpoint`, RFC 7591)
4. Opens authorize with the registered `client_id` + `resource` indicator

The gateway must publish AS metadata with a registration endpoint. There are **no** per-gateway `CLIENT_ID` / `AUTH_URL` config keys.

## Security model

| Piece | Note |
|---|---|
| Listen address | Default `0.0.0.0` so phone redirects work |
| Who can hit the port | Anyone who can reach the host may *attempt* a callback |
| Real protection | High-entropy `state` + PKCE (`code_verifier` never leaves the host) |
| Network preference | Tailscale Serve / tailnet over public Funnel/IP |

## Implementation map

| Area | Path |
|---|---|
| Discovery | `src/mcp/oauth-discovery.ts` |
| PKCE / flow | `src/mcp/oauth-pkce.ts`, `oauth-flow.ts` |
| Token store | `src/mcp/oauth-store.ts` |
| HTTP callback | `src/acp-host/oauth-http.ts` |
| Tests | `test/mcp-oauth.test.ts` |

Env overrides (`ACPBOT_OAUTH_CALLBACK_BASE`, `ACPBOT_OAUTH_*`) work when set; prefer TOML for day-to-day use.
