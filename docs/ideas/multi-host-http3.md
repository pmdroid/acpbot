# Idea: Multi-host agents over HTTP/3

**Status:** parked for later (2026-08-03)
**Branch:** `feature/remote-host-support`
**Not implemented** — design only.

## Intent

Run **`acpbot host` on different servers** (agents execute there). The Telegram **worker** stays the UI and **routes each session** to the right host.

**Transport preference:** use **HTTP/3 (QUIC)** for **bidirectional** worker ↔ host traffic, **without requiring Tailscale**. Private mesh is optional hardening, not the dependency.

---

## Why HTTP/3 fits (and what it does *not* give you for free)

| Need | Unix / TCP today | HTTP/3 |
|---|---|---|
| Reach host across networks without a VPN | No (LAN/Tailscale/SSH) | Yes, if DNS + UDP/443 open + TLS cert |
| Multiplex many sessions on one connection | One NDJSON stream | Many QUIC streams (or one app stream) |
| Connection migration / better loss recovery | Weak (TCP) | Strong (QUIC) |
| **True bidirectional continuous messages** | Natural (socket) | **Not automatic** — plain H3 is request/response |

Important: **HTTP/3 alone is not a socket.** A bare `fetch()` request/response model cannot cleanly carry:

- worker → host: `ensure`, `prompt`, `cancel`, `permission_result`, …
- host → worker: `turn_event`, `permission`, `elicitation`, `ask_user_question`, …

You need a **bidirectional session** layered *on* HTTP/3 (or a deliberate dual-channel design).

---

## Recommended bidirectional design on HTTP/3

### Option A — **WebTransport over HTTP/3** (best semantic fit) ⭐ target

```text
Worker  ── WebTransport (H3/QUIC) ──►  Host
          · 1 bidirectional stream = control (NDJSON lines, same protocol.ts)
          · optional datagrams for heartbeats / cancel
```

- Maps almost 1:1 to today’s NDJSON control plane.
- Multiple sessions can share one WT session (multiplex by `slotKey` in messages — already the case).
- **Caveat:** Bun’s `Bun.serve({ http3: true })` is **experimental request/response H3**. **Server WebTransport is not a first-class Bun API today.** Options:
  - Wait/track Bun WT support, or
  - Use a small Rust/Go WT sidecar next to `acpbot host`, or
  - Use a library when one is solid on Bun.

**Treat WT as the architecture target; do not block MVP on it if Bun isn’t ready.**

### Option B — **Dual HTTP/3 channels** (practical MVP on Bun H3 today)

Bun already supports experimental HTTP/3 on `Bun.serve` (`http3: true` + `tls`). Use two long-lived HTTP semantics:

```text
Worker ── POST /v1/session  (streaming request body) ──► Host   # commands
Worker ◄── GET  /v1/events  (SSE or chunked stream)   ── Host   # events
         Authorization: Bearer <host-token>
```

| Direction | Method | Body |
|---|---|---|
| Worker → host | `POST /v1/cmd` (or duplex stream) | NDJSON lines (`ensure`, `prompt`, …) |
| Host → worker | `GET /v1/events?conn=…` SSE | NDJSON / `data:` events (`turn_event`, `permission`, …) |

- **Bidirectional at the app layer**, one logical connection id, reconnect with cursor/last-event-id.
- Works with Bun H3 **as request handlers** (no WebTransport API required).
- Slightly more reconnect glue than a socket; still fine for LAN and public internet.

**Recommend B for implementation now**, with protocol messages unchanged so Option A can replace the transport later.

### Option C — **WebSocket over TLS (HTTP/1.1)** as interim bidirectional

Mature in Bun (`websocket` on `Bun.serve`). One socket, NDJSON frames. Not HTTP/3, but **internet-reachable without Tailscale** and simple.

Use as:

1. **Spike / Phase 1** if H3 dual-channel is slower to land, or  
2. **Fallback** when UDP/H3 is blocked by corporate NAT (common).

### Option D — Tailscale / SSH tunnels

Still valid for private deployments; **not required**. Design assumes public or self-hosted DNS + certs.

---

## Target architecture (HTTP/3)

```text
Telegram ──► worker (UI + router)
                │
                │  HTTPS/3  (or WSS fallback)
                │  auth: host token (+ mTLS optional later)
                ▼
         ┌──────────────────────────────────────┐
         │  remote acp-host (server B)            │
         │  · TLS cert (public or internal CA)    │
         │  · HTTP/3 listen :443/udp (+ :443/tcp) │
         │  · spawns agents on B                  │
         │  · local [repos] paths on B            │
         └──────────────────────────────────────┘

Local default unchanged:
  worker ── unix acp-host.sock ──► local host
```

Local Unix remains default when no remote hosts are configured (zero regression).

---

## Config sketch

```toml
# Worker: catalog of execution hosts
[hosts.local]
# kind = "unix"  # default — $state_dir/acp-host.sock

[hosts.studio]
kind = "http3"                          # primary remote transport
url = "https://studio.example.com"      # DNS → host; H3 on same port
token = "env:ACPBOT_HOST_TOKEN_STUDIO"
# fallback = "wss://studio.example.com/v1/ws"   # if UDP blocked

# Host process (on studio) — how it listens
[host_listen]
# unix remains for co-located worker
http3 = true
# http1 = true            # dual stack for WS fallback / health
listen_host = "0.0.0.0"
listen_port = 443
tls_cert = "/etc/acpbot/certs/fullchain.pem"
tls_key  = "/etc/acpbot/certs/privkey.pem"
token = "env:ACPBOT_HOST_TOKEN"         # required for non-unix

[repos]
demo = "/Users/you/demo"                # local host

[repos.work]
path = "/data/work"                     # path ON studio
host = "studio"
```

Session store (worker): sticky `hostId`.

---

## Mapping existing protocol → HTTP/3

**Do not redesign message types.** Keep `WorkerToHost` / `HostToWorker` from `src/acp-host/protocol.ts`.

| Transport | Framing |
|---|---|
| Unix / TCP / WebSocket | NDJSON lines on one stream (today) |
| HTTP/3 dual-channel | Same NDJSON: write on POST stream, read on SSE |
| WebTransport | Same NDJSON on one bidi stream |

Router in worker:

```ts
getTransport(hostId) → SessionHost-compatible client
  // createAcpHostClientUnix | createAcpHostClientHttp3 | createAcpHostClientWs
```

`real-agents` / `ensure` / `prompt` stay transport-agnostic.

---

## Reachability without Tailscale (ops)

| Requirement | Notes |
|---|---|
| **DNS** | `studio.example.com` → public or VPS IP of host |
| **UDP/443** | QUIC; many NATs OK, some corporate nets block UDP |
| **TCP/443** | Fallback (H1 + WS or H2) when H3 unreachable |
| **TLS certs** | Let’s Encrypt / Caddy / existing reverse proxy terminating H3 |
| **Firewall** | Only control port + auth; never expose without token |
| **NAT at home** | Port forward or put host on a VPS that can see repos (NFS/sync) — product problem, not protocol |

Cert reuse idea (you already have Tailscale cert auto-detect for OAuth): optional path for *when* Tailscale is present, but **public LE certs are the default path** for “no Tailscale.”

---

## Security (stricter than Unix sock)

Unix socket = local trust. Internet H3 = **hostile network**.

1. **Bearer host token** (required) on every connection / event stream  
2. **TLS required** for `http3` / `wss` (no plain `http://` in production)  
3. Optional later: mTLS worker cert  
4. Rate-limit `hello` / auth failures  
5. Host token ≠ bot token; bot token **never** leaves the worker  
6. Docs: open host control plane = remote code execution on that machine (same disclaimer class as agents)

---

## worker-api (host MCP → Telegram) over the same idea

Remote host MCP tools need a path back to the worker:

```text
Host MCP child  ── HTTPS/3 POST ──►  worker public API
                 Authorization: worker-api token
                 /v1/telegram/send | update | photo | …
```

- Prefer **same HTTP stack** as host control (H3 + token), reverse direction.
- MVP: remote hosts with `mcp = false` until this exists.

OAuth tokens: live on the **host that runs mcp-proxy**. Worker either:

- **Token push** over control channel after `/mcp auth` (MVP), or  
- Host-owned OAuth HTTP (callback on that host’s public URL).

---

## Phased delivery

### Phase 0 — Protocol-neutral transport interface (½ day)

- Extract “byte stream of NDJSON messages” behind `HostTransport`
- Unix path implements it (refactor only)
- Tests green, no behavior change

### Phase 1 — Internet bidirectional MVP (choose B or C)

**1a (fastest):** WebSocket + TLS (`wss://`) — full bidirectional, no Tailscale  
**1b (your preference):** HTTP/3 dual-channel (SSE + POST) on `Bun.serve({ http3: true, tls })`

Exit: worker on machine A, host on machine B, public DNS, one topic session, permissions work.

### Phase 2 — Multi-host router + config

- `[hosts.*]`, per-repo `host`, sticky `hostId`
- `/status` shows host; `/new` badges remote repos
- Local unix default preserved

### Phase 3 — HTTP/3 as primary + WS fallback

- Prefer H3; auto-fallback to WSS if QUIC connect fails  
- Health: `GET /health` on both stacks

### Phase 4 — WebTransport upgrade (when Bun or sidecar ready)

- Swap dual-channel for single WT bidi stream  
- Same NDJSON messages — low app churn

### Phase 5 — Remote worker-api + OAuth ownership

- Host MCP tools + token push / host OAuth

---

## Bun reality check (this repo)

- Runtime types include experimental `Bun.serve` **`http3?: boolean`** (requires `tls`).
- Project currently on **Bun 1.3.x** — H3 is usable for **HTTP handlers**, not proven for WebTransport.
- Compiled `acpbot` binary must ship whatever stack we pick (prefer stdlib Bun; avoid heavy native deps).

**Decision for coding:** implement **HTTP/3 dual-channel (Option B)** as the remote transport that matches “use HTTP/3,” with **WSS fallback (Option C)** for UDP-blocked networks. Keep **WebTransport (Option A)** as the long-term simplification.

---

## What stays local on each host

Unchanged and correct:

- `spawn(agent)` + ACP stdio  
- `terminal/*` / client `fs/*` (host machine)  
- Schedule ticker for that host’s repos  
- Per-host `state_dir` (sessions, oauth)

Worker never SSHes or `docker exec`s agents; **the remote host process does**.

---

## Non-goals (v1)

- Tailscale as a hard requirement  
- Live session migration between hosts  
- Exposing host without auth  
- Redesigning ACP or Telegram UX beyond host badge/status  
- Full WebTransport if Bun isn’t ready (defer to Phase 4)

---

## Risks

| Risk | Mitigation |
|---|---|
| UDP/H3 blocked | WSS fallback |
| Dual-channel reconnect races | `connId` + replay buffer for in-flight permission reqs |
| Chatty `turn_event` over public net | Optional coalesce later; fine on broadband |
| Cert ops burden | Document Caddy/LE; optional reuse of existing oauth TLS helpers |
| Bun H3 experimental | Feature-flag; WSS path production-grade first if needed |

---

## Effort (revised)

| Phase | Size |
|---|---|
| 0 Transport interface | 0.5 day |
| 1 WSS **or** H3 dual-channel MVP | 2–4 days |
| 2 Multi-host router + config/UX | 2–3 days |
| 3 H3 primary + fallback | 1–2 days |
| 4 WebTransport | TBD (Bun/sidecar) |
| 5 worker-api + OAuth remote | 3–5 days |

---

## First PR suggestion

1. **Transport interface + WSS remote host** (proves multi-machine + bidirectional without Tailscale).  
2. **HTTP/3 dual-channel** behind `kind = "http3"` (your preferred stack).  
3. Multi-host catalog / sticky sessions.

If you want H3-only from day one, swap (1) and (2)—expect more reconnect polish on dual-channel.

---

## Summary

Yes: **HTTP/3 can be the public, non-Tailscale path** for worker ↔ remote `acp-host`, with **bidirectional app traffic** carried as:

1. **Near term:** H3 **SSE + POST** (or WSS fallback) wrapping existing NDJSON protocol  
2. **Later:** **WebTransport** single bidi stream when the runtime supports it cleanly  

Multi-host routing, sticky sessions, and per-host agent spawn stay as in the previous plan; only the **wire** changes from “TCP over Tailscale” to “HTTP/3 (and fallback) over the open internet with TLS + token.”
