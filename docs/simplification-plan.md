# tacp simplification plan

Living checklist from the architecture review (2026-08-01).  
**Rule: collect → agree → implement one step at a time. Never start a step without an explicit go-ahead on *if* and *how*.**

## How we work this list

1. Stay on the **next open step** unless you explicitly reorder.
2. Before any code changes for a step, the agent must ask:
   - **Do it?** yes / no / later  
   - **How?** pick options listed under that step (or propose a different how)  
3. After a step ships: mark it done here, note commit(s), open risks.
4. No drive-by refactors outside the agreed step.

---

## North star (do not break)

| Keep | Why |
|------|-----|
| Bot token only in worker | Security boundary |
| MCP → worker Unix API (no token in agent) | Same |
| Topic-per-session Telegram model | Product |
| Working bubble as live status (no topic renames for turns) | Product |
| `Environment` port + fakes for tests | Testability |
| Drain events without awaiting Telegram mid-stream | Correctness |

---

## Progress

| Step | Title | Status |
|------|--------|--------|
| 0 | Orient / decide product stance | **partial** (host + skills decided; bubble open) |
| 1 | acp-host required only (no in-process path) | **done** (2026-08-01) |
| 2 | Skill install: not every boot | **done** (2026-08-01) |
| 3 | Working bubble durability | **open — explain first, no decision yet** |
| 4 | One-time outbound queue cleanup | **done** (2026-08-01) |
| 5 | Rename acpx → state (naming debt) | **done** (hard cut, no alias) |
| 6 | Delete dead shims / aliases | **done** (2026-08-01) |
| 7 | Extract turn runner from daemon | pending |
| 8 | Unify three wait-for-operator UIs | pending |
| 9 | Collapse dual SessionHost paths | pending (stance leans **host required**) |
| 10 | Optional boundary for OAuth / heavy MCP | pending |
| 11 | AgentsPort surface split (optional) | pending |

Statuses: `pending` · `discussing` · `in progress` · `done` · `wontfix` · `open` · `partial`

---

## Step 0 — Orient (product stance)

**Goal:** One sentence each so later steps don’t thrash.

| Topic | Decision | Date |
|-------|----------|------|
| **acp-host** | **Required.** Worker always uses host; no silent in-process fallback as the happy path. | 2026-08-01 |
| **Global skills** | **Do not install every boot.** Install only via explicit `bun run skills:install` (or similar). | 2026-08-01 |
| **Working bubble** | **Not decided yet.** See [Working bubble deep-dive](#working-bubble-deep-dive) below. | — |

---

## Working bubble deep-dive

*Read this before choosing Step 3. No implementation until you say if/how.*

### What it is today

While an agent turn is live, the worker keeps **one Telegram message** in that session’s topic:

| Phase | Message text (examples) |
|-------|-------------------------|
| Turn just started | `⏳ Working…` |
| MCP `update` tool | `⏳ Migrated schema; running tests…` (same message **edited**) |
| Needs you (permission / question) | `❓ Waiting for your decision…` |
| Turn ends / cancel / fail | Message is **deleted**, then the final reply (or error) is sent as a normal new message |

Forum **topic titles stay fixed** (`⏸ repo/name`). Status is only this bubble + optional permanent messages (`telegram_send`, photos, etc.).

### Why we added it

- **Typing indicators** are chat-level / weak with many topics.  
- **Topic renames** (▶ running → ✓ done) were noisy and still didn’t carry free-form progress.  
- One editable line per topic is multi-agent safe: each session only touches its thread.

### How it’s implemented (important limitation)

```text
workingStatusMsg: Map<sessionKey, telegramMessageId>   // in-memory only
```

- Message id is **not** written to `TACP_STORE_PATH` / session index.  
- On **worker restart**, the map is empty even if Telegram still shows an old `⏳` / `❓`.  
- Next turn (or next `update`) posts a **new** bubble; the old one is orphaned until someone deletes it by hand.

Agent process can still be alive in **acp-host** across worker restarts. So:

| What survives worker restart? | Today |
|------------------------------|--------|
| Agent process (with host) | Yes (if host stayed up) |
| Session ↔ topic mapping | Yes (store) |
| Working bubble message id | **No** |
| Ability to edit/delete the old bubble | **No** |

That mismatch is the only real “durability” question — not whether the bubble idea is good.

### What can go wrong (concrete)

1. Worker dies mid-turn → topic still shows `⏳ Working…` forever (orphan).  
2. Worker comes back, turn still running in host (if any) → MCP `update` may create a **second** bubble.  
3. Permission wait across restart → user still sees `❓` but worker may not know which message to edit when they answer (permission state is also mostly in-memory / RPC-bound — related but separate).  
4. Clean path (no restart): bubble create → edit → delete works well; this is what you already liked in normal use.

### What “persist the bubble” would mean

Save `workingMessageId` (and maybe last text) on the session record, then on boot:

- **Optional cleanup:** if session is idle/done, `deleteMessage` the old id (best-effort).  
- **If turn still active** (harder — worker may not know): reattach id so `update` edits the same line.

Complexity is low for “save id + delete if idle”; higher if we want perfect mid-turn reattach across worker restart.

### Options when you decide (Step 3) — still open

| Id | Approach | Pros | Cons |
|----|----------|------|------|
| **3a** | Persist `workingMessageId` on session; edit/delete using store after restart | Few orphans; small code | Must handle Telegram “message not found” |
| **3b** | Keep memory-only; document that restart can leave a stale line | Zero work | Orphans until user scrolls past |
| **3c** | 3a + on hydrate: if session not `running`/`waiting-on-you`, try delete bubble | Clean topics after crash when turn is over | Idle detection must match real agent state |
| **3d** | On every new turn start: don’t rely on old id; always new bubble; try delete known old id if any | Simple | Still needs store for “known old id” or accept orphans |
| **3e** | Something else you prefer (e.g. leave bubble, never delete — history of status) | — | Chat gets noisier |

**You do not need to pick this now.** Steps 1–2 can proceed without it.

---

## Step 1 — acp-host boot policy

**Stance:** host is **required** (from Step 0).

**Problem:** Worker defaults to host client but does not fail fast if the socket is missing; first turn fails late.

**Options (pick one how):**

| Id | How |
|----|-----|
| 1a | **Fail worker boot** if host socket missing (print path + `bun run acp-host`) — best match for “required” |
| 1b | Connect/ping host at boot; fail with clear error if unreachable |
| 1c | 1a + optional health in `/ping` or startup log only (redundant if boot fails) |

**Not in play (conflicts with stance):** silent in-process fallback (old 1b-style).

**Touch:** `src/acp-host/client.ts`, `src/main.ts`, docs  
**Verify:** boot without host fails; boot with host ok  

**Status:** **done** — host only; boot asserts socket + ping; `TACP_ACP_HOST=0` removed; in-process path removed from `realAgents` (tests may still inject `host`).

---

## Step 2 — Skill install: not every boot

**Stance:** **do not** install skills on every worker boot (from Step 0).

**Problem today:** `main.ts` runs `installBundledSkills` unless `TACP_SKIP_SKILL_INSTALL=1`. Installer can also clobber non-owned dirs (`rm -rf` destination).

**Options (pick one how):**

| Id | How |
|----|-----|
| 2a | **Remove auto-install from `main.ts`**; document `bun run skills:install` as the only path |
| 2b | 2a + harden installer so it never deletes non-symlink / foreign targets (safe if someone runs install by hand) |
| 2c | Keep boot install only when `TACP_INSTALL_SKILLS=1` (default off) — still not “every boot” |

**Recommend:** **2b** (remove boot path + safe installer).

**Touch:** `src/main.ts`, `src/core/bundled-skills.ts`, docs/skills, getting-started  
**Verify:** start worker does not touch `~/.agents/skills`; `skills:install` still works  

**Status:** **done** — boot install removed; installer never clobbers non-symlink skill dirs.

---

## Step 3 — Working bubble durability

**Status:** **open** — see [Working bubble deep-dive](#working-bubble-deep-dive).  
No options chosen. Do not implement until you decide.

---

## Step 4 — One-time outbound queue cleanup

**Problem:** Disk `telegram-queue` / `speak-queue` removed; leftover `.req.json` under state dir never drained.

**Options:**

| Id | How |
|----|-----|
| 4a | On worker start: if old queue dirs exist, log + delete (or move to `*.bak`) |
| 4b | On worker start: warn only with path, do not delete |
| 4c | No code; release note only |

**Touch:** `main.ts` or small `src/core/legacy-cleanup.ts`  
**Verify:** test with temp dir containing fake queue files  

**Status:** **done** — `cleanupLegacyOutboundQueues` removes `telegram-queue` / `speak-queue` under state dir at boot (4a).

---

## Step 5 — Rename acpx → state (naming debt)

**Problem:** Fork is gone; env and fields still say `TACP_STATE_DIR` / `stateDir`.

**Options:**

| Id | How |
|----|-----|
| 5a | New primary `TACP_STATE_DIR`; accept old `TACP_STATE_DIR` as alias (warn once) |
| 5b | Rename in code comments/types only; keep env var string forever |
| 5c | Hard rename env only (breaking) |

**Touch:** `config.ts`, main, acp-host, mcp, docs, `.env.example`  
**Verify:** loadConfig tests for alias  

**Status:** **done** — `TACP_STATE_DIR` / `stateDir` only; no `TACP_ACPX_*` alias.

---

## Step 6 — Delete dead shims / aliases

**Problem:** Dead weight after product shifts.

**Candidates (done):**

- [x] `renameTopic` → only `setSessionStatus`  
- [x] `buildAcpRuntimeOptions` + deprecated `Runtime` / `RuntimeHandle`  
- [x] `extractSpeakFromReply` (tests use `stripSpeakMarkers`)  
- [x] `topicName` no longer takes unused status arg  
- [x] `echoAgents` not exported from package `index` (tests import env path)  
- [x] `shouldUseAcpHost` removed (always host)

**Status:** **done**

---

## Step 7 — Extract turn runner from daemon

**Problem:** `daemon.ts` ~3.2k lines; turn lifecycle mixed with routing.

**Extract (proposed modules):**

- `src/core/turn-runner.ts` — `drainTurn`, working bubble, TTS at end  
- optional `src/core/working-status.ts` — bubble ensure/set/clear  

Daemon keeps: session create, message routing, slash commands, wiring handlers.

**Options:**

| Id | How |
|----|-----|
| 7a | Move functions only (same behavior, inject deps) |
| 7b | Small class/object `TurnRunner` with explicit deps |
| 7c | Defer until after interactive-prompt unify (step 8) |

**Verify:** existing turn / echo / drain-queue tests green  

**Status:** pending — ask if/how

---

## Step 8 — Unify three wait-for-operator UIs

**Problem:** Permission / elicitation / ask-user are copy-paste pipelines.

**Options:**

| Id | How |
|----|-----|
| 8a | Shared helper only: `awaitInlineDecision({ text, keyboard, signal })` + keep three brokers |
| 8b | One broker + adapters for ACP payload shapes |
| 8c | Defer; leave as-is |

**Verify:** permission / elicitation / ask-user tests  

**Status:** pending — ask if/how

---

## Step 9 — Collapse dual SessionHost paths

**Problem:** Local `createSessionHost` + remote client + host process all maintain the same surface.

**Depends:** Step 0 + Step 1  

**Options:**

| Id | How |
|----|-----|
| 9a | Host required: delete in-process path from production `realAgents` (keep for tests via inject) |
| 9b | In-process only: deprecate acp-host process (schedules/OAuth move to worker) |
| 9c | Keep both indefinitely (wontfix simplification) |

**Status:** pending — ask if/how

---

## Step 10 — Optional boundary for OAuth / heavy MCP

**Problem:** ~1.6k OAuth + ~1k repo-mcp for a secondary path.

**Options:**

| Id | How |
|----|-----|
| 10a | Document as optional; no code split |
| 10b | Gate remote MCP + OAuth behind `TACP_REMOTE_MCP=1` (default off) |
| 10c | Move OAuth into separate entry/package later |

**Status:** pending — ask if/how

---

## Step 11 — AgentsPort surface split (optional)

**Problem:** One fat optional interface for runtime + config + hooks.

**Options:**

| Id | How |
|----|-----|
| 11a | Split types only (`SessionRuntime` / `SessionConfig` / `OperatorHooks`) still one object in env |
| 11b | Real multi-object Environment fields |
| 11c | Skip |

**Status:** pending — ask if/how

---

## Out of scope unless reopened

- Restoring disk speak/telegram queues  
- Topic title status renames (▶/✓)  
- Rewriting ACP SDK usage  
- Multi-operator / multi-chat  

---

## Log

| Date | Note |
|------|------|
| 2026-08-01 | Plan created from architecture review; no steps implemented yet. |
| 2026-08-01 | Step 0 partial: **acp-host required**; **no skill install every boot**. Working bubble left open + deep-dive added. |
| 2026-08-01 | Step 1 done: worker **only** uses acp-host; fail-fast `assertAcpHostReady`; no in-process agents / no `TACP_ACP_HOST=0`. |
| 2026-08-01 | Step 2 done: no skill install on boot; safe installer (no clobber of real skill dirs). |
| 2026-08-01 | Step 4 done: boot removes legacy `telegram-queue` / `speak-queue` under state dir. |
| 2026-08-01 | Step 5 done (hard cut): `TACP_STATE_DIR` only; no ACPX alias; repo inject → `TACP_REPO_STATE_DIR`. |
| 2026-08-01 | Step 6 done: dead shims removed (renameTopic, Runtime*, extractSpeak, shouldUseAcpHost, …). |

---

## Next action for the agent

1. Do **not** implement until asked.  
2. When ready: propose **Step 1** (host required → fail-fast boot) and/or **Step 2** (drop boot skill install) — ask **if/how**.  
3. Step 3 only after user picks a bubble option (or explicitly skips).
