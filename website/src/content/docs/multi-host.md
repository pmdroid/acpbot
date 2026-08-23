---
title: Multi-host
description: Run acp-host on other machines; worker routes repos by host over authenticated WSS.
order: 14
section: advanced
---

By default the Telegram **worker** and **acp-host** run on the same machine (Unix socket).  
**Multi-host** lets you run `acpbot host` on other machines (GPU box, Orb VM, studio) and have the worker **route each repo’s agents** to the host that owns that workspace.

Design background: [multi-host design note](https://github.com/pmdroid/acpbot/blob/main/docs/ideas/multi-host-http3.md) (repo).

## When to use it

| Setup | Use multi-host? |
|---|---|
| Laptop only | No — default local Unix host is enough |
| Agents must run where the code lives (big machine) | Yes — host on that machine, worker wherever you use Telegram |
| Isolate agent processes from the bot token machine | Yes — worker keeps the bot token; host never needs it for agent spawn |

## Architecture

```text
Telegram ──► worker (UI)
                │
                ├─ repo "demo"  → host local   (unix acp-host.sock)
                └─ repo "work"  → host studio  (wss://studio:8790 + token)
                                    │
                                    ▼
                              acp-host on studio
                              cwd = path on studio
```

- **Worker** owns Telegram, pairing, session index, routing.
- **Each host** owns agent stdio, schedules for its repos, and (optionally) OAuth if that host uses remote MCP.
- **Path** in config is the filesystem path **on the machine that runs that host**, not necessarily on the worker.

## Config

### 1. Hosts catalog

```toml
# Optional — "local" is always implied (Unix socket under state_dir)

[hosts.studio]
kind = "wss"
url = "wss://studio.example.com:8790"   # or ws:// for trusted LAN / Orb
token = "env:ACPBOT_HOST_TOKEN_STUDIO"  # or a literal (prefer env:)
```

| Field | Meaning |
|---|---|
| `kind` | `wss` (or `ws`) for remote; omit / unix for local |
| `url` | WebSocket URL of that host’s remote listen port |
| `token` | Shared secret; must match that host’s `[host_listen].token` |

Env shortcuts (single remote):

| Env | Effect |
|---|---|
| `ACPBOT_ACP_HOST_URL` | Registers host id `remote` with this URL |
| `ACPBOT_HOST_TOKEN` | Token for that remote (and for `[host_listen]` on the host process) |

### 2. Bind a repo to a host

String form (unchanged) = **local**:

```toml
[repos]
demo = "/Users/you/code/demo"
```

Table form with host:

```toml
[repos.work]
path = "/data/work"    # path ON studio
host = "studio"
```

The worker routes `work/*` sessions to `hosts.studio`.  
There is **no silent fallback** to local if that host is missing, unauthorized, or down.

### 3. Accept remote workers (on the host machine)

On the machine that should **run agents for others**:

```toml
[host_listen]
port = 8790
host = "0.0.0.0"       # all interfaces (LAN / Tailscale / Orb)
token = "env:ACPBOT_HOST_TOKEN"
```

Same via env: `ACPBOT_HOST_LISTEN_PORT`, `ACPBOT_HOST_LISTEN_HOST`, `ACPBOT_HOST_TOKEN`.

Restart **host** after changing listen settings. Prefer **`wss://` + TLS** on untrusted networks; plain `ws://` is fine on a private LAN or Orb network for smoke tests.

## Guided setup

```bash
acpbot setup
```

After OAuth, an optional step **“Remote agent hosts”** can:

1. Enable **`[host_listen]`** on this machine (port, bind, generate/enter token)  
2. Add **`[hosts.*]`** remotes (id, URL, token)  
3. Bind each **`[repos]`** entry to `local` or a remote id  

Default is **skip / local only**. Re-run setup anytime to keep, reconfigure, or clear multi-host.

## Routing rules

For session key `repo/name` (e.g. `work/plan`):

1. If a sticky host id is set for the session → use it (API reserved; normally unset)  
2. Else use `[repos.<repo>].host`  
3. Else **`local`**

Every agent RPC (`ensure`, prompt, cancel, mode/model, **`computer_grant`**) goes through the same resolution, so a session stays on one host as long as the repo binding is stable.

### Computer use — which host’s browser?

The isolated Playwright browser is owned by **that session’s acp-host**, not the worker.

| `[repos.work].host` | Browser driven |
|---|---|
| `"studio"` | Chromium on **studio** (studio.local) |
| unset / `"local"` | Chromium on the **local** host |

If studio is down, `/computer on` fails the same way `ensure` does — **no silent fallback** to the worker laptop. Frames travel host → worker on `slot.owner` (the session router connection), never via `eveHost`.

If hot-reload rebinds `[repos.work].host`, the worker revokes the grant and sends `computer_abort` to the **previous** host.

## Security

- Remote control plane requires a **shared token** (hello handshake before any ensure/prompt).
- Invalid token → rejected; do not put the Telegram bot token on remote hosts.
- Open host listen only on trusted networks or behind Tailscale; treat a leaked host token like shell access on that box.
- Same disclaimer as local agents: the host machine’s agent can read/write its mounted workspaces.

## Related

- [Configuration](/docs/configuration) — full `config.toml` reference  
- [Architecture](/docs/architecture) — worker vs acp-host  
- [Repos](/docs/repos) — workspace roots and `acpbot repo`  
- [OAuth](/docs/oauth) — remote MCP (per-host state if OAuth runs on that host)  
