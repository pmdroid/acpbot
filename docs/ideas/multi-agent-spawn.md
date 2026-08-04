# Idea: Multi-agent spawn via MCP tools (parent-linked slots)

**Status:** parked for later (2026-08-04)
**Branch:** `feature/remote-host-support`
**Not implemented** — design only.

Related: [multi-host-http3.md](./multi-host-http3.md) (where agents run). This doc is **how many agents cooperate** and how they talk.

## Intent

A **parent** ACP agent spawns other ACP agents through **acpbot MCP tools**. acpbot **owns lifecycle**, **links every child slot to its parent slot**, and provides an **A2A bridge** so plan → multi-agent implement → review works without the human juggling topics manually.

---

## Decision: tools **or** CLI — pick **tools only**

| Surface | Verdict |
|---|---|
| **MCP tools** (primary, **only v1 surface**) | Agents already talk MCP; no shell permission theater; same path as `schedule_*` / `telegram_*` |
| **`acpbot agent …` CLI** | **Out of scope for v1** — defer; avoid two APIs to keep in sync |
| **Skill** | Teaching layer **for the MCP tools only** (not “how to shell out to the binary”) |

**Rationale:** Dual surfaces (tools + CLI) double design/test load and drift. The caller is almost always an agent mid-turn → MCP is the natural API. Humans keep using Telegram (`/new`, `/sessions`, child topics). A CLI can be a later thin wrapper over the same worker-api if ops need it; it is **not** part of this plan.

Skill documents tool names + recipes only. No `acpbot agent spawn` in the skill.

---

## What exists today (hooks)

| Building block | Reuse |
|---|---|
| Topic = session (`repo/name`) | Child sessions are sessions |
| Host **slotKey = sessionKey** | Child = new slot; parent link is **extra metadata**, not a second ID space |
| Host MCP + worker-api | Add `agent_*` tools like `schedule_*` |
| Free-text queue / busy slots | A2A send while child busy |
| Skills embed | New skill: multi-agent **tools** usage |

---

## Storage model: child slots **always** linked to parent

### Invariant

> Every spawned child has a durable record with a **non-null `parentSessionKey`** equal to the parent’s host **slotKey** (which is the parent `sessionKey`).  
> No orphan children. Kill/dispose of parent can cascade (policy) or reparent (v1: cascade cancel only).

### Keys

| Field | Meaning |
|---|---|
| `sessionKey` / host `slotKey` | Unique agent process slot = `repo/name` (unchanged) |
| `parentSessionKey` | **Required** for children; **absent/null** only for operator-created roots (`/new`) |
| `runId` | Stable uuid for this spawn edge (parent→child), for A2A correlation |

Parent sessionKey is the **foreign key**. Child sessionKey is the **primary key** of the child slot.

```text
Operator /new work/plan     → slot work/plan          parent=null
agent_spawn name=impl       → slot work/plan--impl    parent=work/plan
agent_spawn name=review     → slot work/plan--review  parent=work/plan
```

Naming (fixed convention):

- Child name slug: `^[a-z0-9][a-z0-9-]{0,31}$`
- Child sessionKey: `{parentSessionKey}--{slug}`  
  - Parent already `repo/name` → child `repo/name--slug`  
  - If parent is itself a child `repo/a--b`, grandchild `repo/a--b--c` (depth cap applies)
- Reject if sessionKey exists.

### Durable records

**A. Extend session index (worker store)** — operator / Telegram truth

```ts
// PersistedSession (extend)
type PersistedSession = {
  sessionKey: string;
  identity: SessionIdentity;
  messageThreadId: number;
  chatId: number;
  status: SessionStatus;
  cwd: string;
  permissionMode?: "ask" | "bypass";
  createdAt: number;
  updatedAt: number;

  /** null/undefined = root (operator /new). Set = spawned child of that slot. */
  parentSessionKey?: string | null;
  /** Spawn edge id when created via agent_spawn */
  spawnRunId?: string;
  /** Optional role label from parent */
  spawnRole?: string;
};
```

**B. Spawn registry (worker state file)** — tree + A2A bookkeeping  
Path: `$state_dir/agent-spawns.json` (or store key `agents:spawns`)

```ts
type SpawnRecord = {
  runId: string;
  /** Child host slotKey / sessionKey */
  childSessionKey: string;
  /** Parent host slotKey / sessionKey — REQUIRED, immutable after create */
  parentSessionKey: string;
  agent: string;
  role?: string;
  status: "starting" | "idle" | "running" | "waiting" | "done" | "failed" | "killed";
  createdAt: number;
  updatedAt: number;
  lastResultSummary?: string;
  /** Optional depth from root (root children = 1) */
  depth: number;
};

type SpawnIndex = {
  /** childSessionKey → record (unique child) */
  byChild: Record<string, SpawnRecord>;
  /** parentSessionKey → childSessionKey[] */
  byParent: Record<string, string[]>;
};
```

**Indexes always updated together** on spawn/kill:

1. Create Telegram topic + `PersistedSession` with `parentSessionKey`
2. Insert `SpawnRecord`; append to `byParent[parent]`
3. Host `ensure` child slot

**Queries:**

- `agent_list` from parent → `byParent[parentSessionKey]`
- “Who is my parent?” → `byChild[self].parentSessionKey` or `PersistedSession.parentSessionKey`
- Root tree → walk `byParent` from root sessionKey

### Host slot linking

acp-host today: `slots: Map<slotKey, Slot>` with no parent field.

**MVP:** parent link lives in **worker registry only**; host stays “flat slots.” Worker enforces all spawn/send/kill authorization using `parentSessionKey`.

**Optional later:** pass `parentSessionKey` in host `ensure` config for host-side metrics / cascade kill if worker dies — not required for v1.

### Authorization rules (enforced in worker-api)

| Action | Allowed if |
|---|---|
| `agent_spawn` | Caller sessionKey is a live session; depth & caps OK |
| `agent_list` | Own children (byParent[caller]); not arbitrary trees |
| `agent_send` to child | `byChild[to].parentSessionKey === caller` **or** caller is that child sending to parent |
| `agent_wait` / `status` / `kill` | Same as send (parent of child, or self) |
| Sibling → sibling | **Denied** in v1 (parent is hub) |

### Cascade on parent dispose

When operator ends parent topic or `agent_kill` on parent with `cascade: true` (default for kill if we add parent kill later):

1. List `byParent[parent]`
2. Cancel + kill each child slot
3. Remove spawn records + optional archive

v1 minimum: **spawn/list/send/wait/kill child**; parent delete from `/sessions` cleanup walks children via `byParent`.

### Consistency

- `parentSessionKey` on `PersistedSession` and `SpawnRecord` must match; spawn path writes both in one critical section (in-memory mutex per parent).
- Never create a host slot for a spawn without both records.
- Never leave `byParent` entry without `byChild` (and vice versa).

---

## Product flow

```text
Operator ── topic parent (slot work/plan)
                 │
                 │ MCP agent_spawn / agent_send / agent_wait
                 ▼
              worker (registry + topics)
                 │  parentSessionKey links
                 ├─► slot work/plan--impl    parent=work/plan
                 └─► slot work/plan--review  parent=work/plan
```

### MCP tools (only agent-facing API)

| Tool | Purpose |
|---|---|
| `agent_spawn` | Create child session/slot linked to caller; optional kickoff prompt |
| `agent_list` | Children of caller (from `byParent`) |
| `agent_send` | A2A message → prompt/steer on linked peer |
| `agent_wait` | Wait until child idle/done/failed; return `lastResultSummary` |
| `agent_status` | One child (must be linked) |
| `agent_kill` | Cancel/dispose child; remove from indexes |

### Tool sketch

```ts
agent_spawn({
  name: "impl-auth",        // slug → sessionKey parent--slug
  agent?: "codex",
  role?: "implementer",
  prompt?: "…",
  permission_mode?: "ask" | "bypass",
})
// → { runId, sessionKey, parentSessionKey, status }

agent_send({
  to: "impl-auth" | "work/plan--impl-auth" | "parent",
  message: "…",
  mode?: "prompt" | "steer",
})

agent_wait({ id?: runId, sessionKey?: "…", timeout_sec?: 600 })
agent_list({})
agent_kill({ sessionKey | id, dispose?: true })
```

MCP → `POST /v1/agents/*` on worker-api → daemon (createSession, ensure, prompt, registry).

### Skill (tools only)

`skills/multi-agent/SKILL.md`:

- When to fan out after a plan
- Tool recipes only (no CLI)
- Caps, no secrets in A2A, parent as hub
- Depth / max children

### A2A

- Envelope in prompt text with `from`, `to`, `runId` / `parentSessionKey`
- Results: final child turn text → `lastResultSummary` for `agent_wait`
- Sibling traffic: only via parent in v1

### Operator UX

- Notice in parent topic on spawn (child topic link)
- Child topics normal Telegram sessions with `parentSessionKey` in store
- `/sessions` can indent children under parent (small daemon UX add)

---

## Config

```toml
[agents.spawn]
enabled = true
max_children_per_parent = 4
max_depth = 2
max_concurrent_spawned = 8
default_child_permission = "ask"
# allow_agents = ["grok-build", "claude", "codex", "opencode"]
```

---

## Architecture

```text
src/mcp/server.ts              agent_* tools only
src/mcp/worker-api.ts          client
src/core/worker-api-server.ts  routes
src/core/daemon.ts             spawn/send/wait/kill handlers
src/core/agent-spawn-registry.ts   byChild / byParent + invariants
src/core/persistence.ts        parentSessionKey on PersistedSession
skills/multi-agent/SKILL.md
test/agent-spawn.test.ts
```

**No** `acpbot agent` CLI in this plan.

---

## Plan → multi-agent implement

```text
Parent plans → operator OK
  agent_spawn name=impl agent=codex prompt=<plan slice>
  agent_wait …
  agent_spawn name=review agent=claude prompt=<review impl summary>
  agent_wait …
  Parent replies to operator
```

Parallel: multiple spawns, then multiple waits (bounded by caps).

---

## Phases

| Phase | Work |
|---|---|
| **1** | Registry (`byChild`/`byParent`) + `PersistedSession.parentSessionKey` + `agent_spawn` / `list` / `kill` |
| **2** | `agent_send` + `agent_wait` + result summary |
| **3** | Skill + `/sessions` indent + docs |
| **4** | Caps polish, cascade on parent close, optional host metadata |

---

## Non-goals (v1)

- **`acpbot` CLI for spawn** (explicitly deferred)
- Headless children (no topic)
- Sibling mesh without parent
- Multi-host routing (separate idea)
- Replacing Grok-internal subagents

---

## Effort

| Phase | Size |
|---|---|
| 1 Parent-linked spawn/list/kill | 3–5 days |
| 2 Send/wait | 2–4 days |
| 3 Skill + sessions UX | 1–2 days |

---

## Summary

- **One surface:** MCP tools + teaching skill. **No CLI** in v1.  
- **Storage:** every child slot is linked to its parent via immutable `parentSessionKey` on both `PersistedSession` and `SpawnRecord`, with `byParent` / `byChild` indexes so trees stay consistent and A2A stays authorized.
