# Remote MCP OAuth

Tokens are **never** written to the repo. They live under:

```text
$TACP_ACPX_STATE_DIR/mcp-oauth/by-repo/<repoKey>/<id>.json   # mode 0600
$TACP_ACPX_STATE_DIR/mcp-oauth/pending/                      # PKCE in flight
```

## Shared absolute state dir

`/mcp auth` runs in the **Telegram worker** and writes pending PKCE.  
`GET /oauth/callback` and session ensure run on **acp-host**.

Both processes **must** use the **same absolute** `TACP_ACPX_STATE_DIR`. Prefer an absolute path in `.env` so different CWDs cannot diverge. Boot logs print the resolved path on both processes.

## Setup

```bash
# Reachable from the phone browser (prefer Tailscale Serve)
TACP_OAUTH_CALLBACK_BASE=https://your-host.ts.net
# or http://100.x.y.z:8788

# Optional listen bind (defaults shown)
# TACP_OAUTH_LISTEN_HOST=0.0.0.0
# TACP_OAUTH_LISTEN_PORT=8788
```

Run:

```bash
bun run acp-host   # serves GET /oauth/callback when base is set
# worker with same TACP_ACPX_STATE_DIR
```

If bind fails (port in use), **acp-host exits** with a clear error when the callback base is set. Free the port or use the paste fallback below.

## Operator flow

1. In a session topic: `/mcp add <id> <url>`
2. `/mcp auth <id>`
3. Open the **tappable authorize URL** in Telegram (host does not open a browser)
4. On callback, PKCE completes; Bearer tokens merge into remote MCP at ensure
5. Pending PKCE expires after **15 minutes**

When `TACP_OAUTH_CALLBACK_BASE` is set, ensure **fail-closes** if a remote MCP has no token:

```text
MCP "<id>" has no OAuth token; run /mcp auth <id>
```

### Paste fallback

If the redirect cannot reach the host:

1. Prefer `/mcp code <full-callback-url>` (includes `code` + `state`)
2. Last resort: `/mcp code <code> <id>`

## Discovery (no env client_id / auth URL)

On `/mcp auth`, tacp:

1. Probes the MCP URL for `WWW-Authenticate` `resource_metadata` (RFC 9728), else fetches `/.well-known/oauth-protected-resource…`
2. Loads authorization-server metadata (RFC 8414)
3. Dynamically registers a public PKCE client (`registration_endpoint`, RFC 7591)
4. Opens authorize with the registered `client_id` + `resource` indicator

The gateway must publish AS metadata with a registration endpoint. There are **no** `TACP_MCP_OAUTH_*_AUTH_URL` / `_CLIENT_ID` overrides.

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
