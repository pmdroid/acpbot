# Idea (later): keep ACP agent alive across tacp restarts

**Status:** implemented — `bun run acp-host` is **required**; worker fails boot without host socket

See `src/acp-host/` and README “ACP host”. Remaining polish: auto-start host from worker, richer lease/ping, multi-worker.  
**Context:** thin ACP host (`@agentclientprotocol/sdk`); today each topic session spawns `grok agent stdio` (etc.) as a **child of the tacp daemon**. Restarting tacp tears down (or orphans) that process and requires re-spawn + optional `session/load`.  
**Related PR:** thin host / durable store / modes on `feat/acp-typescript-sdk-host`.

## Problem

Operators restart tacp often (deploys, crashes, config). Losing the agent process means:

- cold start latency
- lost in-memory tool/terminal state
- conversation continuity only if the agent supports `session/load` well

What we want eventually: **tacp (Telegram worker) can restart freely; ACP agent process(es) stay warm.**

## Why it’s not trivial

Keeping a process alive is easy. **Reconnecting a new worker to the same live ACP session** is the hard part.

ACP is bound to a **transport + connection** (stdio or socket):

| Piece | Difficulty | Notes |
|-------|------------|--------|
| Agent process not tied to worker lifetime | Easy | Detach / separate supervisor / leader |
| Worker finds that process again | Medium | Known socket, PID file, or supervisor API |
| Same ACP session still usable | Medium–hard | `session/load`, or a still-open durable connection |

**Naive “detach child + reconnect stdio” does not work** — you cannot reattach to old stdin/stdout after the parent dies.

## Current architecture (baseline)

```text
tacp daemon  ──spawn──►  agent stdio (child)
     │                        │
     └── restart ─────────────┴── child dies or is orphaned;
                                  worker re-spawns + session/new or session/load
```

Durable store (`TACP_STATE_DIR/sessions/`) already persists `sessionKey → agentSessionId` and tries `session/load` when the agent advertises it. That is **rehydrate after re-spawn**, not **warm process**.

## Target mental model

```text
┌─────────────────┐     Unix socket / leader      ┌──────────────────┐
│  tacp (Telegram)│ ◄───────────────────────────► │ agent host /     │
│  restarts freely│                               │ grok leader      │
└─────────────────┘                               │ (long-lived)     │
                                                  └──────────────────┘
```

- **Worker** = stateless-ish UI (Telegram, permissions, TTS, mode slash commands).
- **Agent host** = owns ACP processes and (optionally) session mapping.

## Approaches (for later evaluation)

### A. Grok leader / shared backend (prefer first if Grok-only)

Grok already has leader-style sharing (`--leader`, leader socket): one long-lived backend; clients connect.

- **Effort:** low–medium if the leader API is stable for ACP.
- **Fit:** best for “restart tacp, keep Grok warm.”
- **Not:** portable to every agent without similar support.

### B. External supervisor / small `tacp-agent-host` daemon

- systemd / launchd / tiny node process owns children.
- tacp talks over **Unix socket** (not as parent of the agent).

- **Effort:** medium (extra process + thin reconnect protocol).
- **Payoff:** multi-agent, clean restarts, clear ownership.

### C. `session/load` only (already mostly done)

- Always re-spawn on worker start; load if supported.

- **Effort:** done / polish only.
- **Limit:** no warm tools/terminals; history only as good as agent load.

### D. Full warm session owner / queue owner

- Multi-agent warm pool, leases, multi-client ownership.

- **Effort:** weeks; high complexity.
- **Only if** we need multi-agent host product parity beyond Grok-first tacp.

## What would be hard even with a host

- Mid-turn worker restart (open prompts, permission UIs, live terminals)
- Exactly-once reconnect vs double-attach
- Agent crash vs worker crash policies
- Mapping Telegram topics ↔ host session leases after restart
- Auth / API keys living in the host, not only in the worker env

## Suggested first slice (when we pick this up)

1. **Optional “agent host” mode** that only supervises Grok (`stdio` or leader socket).
2. tacp connects to host over a local socket instead of spawning directly.
3. Keep durable store as fallback when host is down or agent lacks live reconnect.
4. Explicit Telegram UX if session was rehydrated vs freshly created.

Non-goals for v1 of this idea: full multi-agent pool, Windows parity, queue-owner clone.

## Decision (when revisited)

Prefer **A (Grok leader) or B (small agent host)** over detaching stdio children.  
Do **not** invest in C-as-only-path if warm process is a product requirement.

## References

- Thin host: `src/acp/session-host.ts`
- Durable records: `src/acp/session-store.ts`
- Terminal (client surface): `src/acp/terminal-manager.ts` (full process-group support; still dies with agent process)
- Historical warm session / queue owner designs (intentionally left behind for Grok-first tacp)
- Grok CLI: `grok agent stdio`, `--leader` / leader socket (verify current flags when implementing)
