---
title: Agents
description: Built-in agents, /model, /agent, modes and effort.
order: 11
section: reference
---

## Built-in agent registry

Defined in `src/acp/agent-launch.ts`. The `/agent` picker **only lists agents whose required binaries are on `PATH`**.

| Id | Label | Launch | Requires |
|---|---|---|---|
| `grok-build` | grok | `grok agent stdio` | `grok` |
| `claude` | claude | `npx -y @agentclientprotocol/claude-agent-acp@0.64.0` | `npx`, `claude` |
| `codex` | codex | `npx -y @agentclientprotocol/codex-acp@1.1.7` | `npx`, `codex` |
| `opencode` | opencode | `opencode acp` | `opencode` |

Adapter pins (npm) — TOML `[agents]` or env override:

| TOML / env | Default |
|---|---|
| `agents.claude_acp_pkg` / `ACPBOT_CLAUDE_ACP_PKG` | `@agentclientprotocol/claude-agent-acp@0.64.0` |
| `agents.codex_acp_pkg` / `ACPBOT_CODEX_ACP_PKG` | `@agentclientprotocol/codex-acp@1.1.7` |

Upstream: [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp), [codex-acp](https://github.com/agentclientprotocol/codex-acp).

**Aliases** (normalized before launch):

| Input | Canonical |
|---|---|
| `grok`, `xai`, `grok-build` | `grok-build` |
| `claude-code`, `claude-acp` | `claude` |
| `opencode-ai`, `open-code` | `opencode` |

### Overrides

```toml
default_agent = "grok-build"

[agents]
# command_json = '{"grok-build":{"command":"grok","args":["agent","stdio"]}}'
# claude_acp_pkg = "@agentclientprotocol/claude-agent-acp@0.64.0"
```

JSON command overrides merge on top of the built-in registry (same shape: `command` + `args`).

### Backend

The worker **always** uses real ACP agents (`realAgents` → acp-host by default).  
Unit tests may still import `echoAgents` as an in-memory fake.

## `/agent` — switch process mid-session

- Shows a picker of available agents (+ any ids from `agents.command_json`)
- Or `/agent <id>`
- Respawn the agent for **this topic**; persists `identity.agent`
- Mid-turn: cancel then switch
- With **acp-host**, ensure reattaches/respawns the slot for the new agent

## `/model` — switch LLM

Sources of model lists (first available wins in practice):

1. ACP `session.models` / model notifications (e.g. Grok Build `session/set_model`)
2. ACP `configOptions` with model category + `session/set_config_option`
3. Canned fallbacks for known agents (and spawn `-m` / env where applicable)

Usage:

- `/model` → button list
- `/model <value>` → set directly
- Mid-turn cancels the turn, then applies

`/status` shows **Agent**, **Launch**, **Mode**, **Model**, **Effort**, and **Permissions** as distinct fields. With multi-agent spawn, parents also list **children** (status + age) and children show their **parent** link — see [Multi-agent](/docs/multi-agent).

## Tool permissions (ask vs bypass)

Separate from session **mode** (plan/build). Controls whether **ordinary tool** calls show Telegram approve buttons.

| Setting | Effect |
|---|---|
| `ask` (default) | Each tool permission → Telegram keyboard (message **deleted** after you answer) |
| `bypass` | Host **auto-allows** tool `request_permission` (no keyboard). Agent still runs without Grok `--always-approve` / `yoloMode` |

**Why not Grok always-approve?** Grok’s yolo / `--always-approve` short-circuits **`exit_plan_mode`** (plan approval) and cancels the turn without a client permission UI — so Telegram never gets Approve/Reject for the plan. Host bypass still auto-allows shell/fs tools; plan exit is **always forced to ask** (see below).

Duplicate concurrent prompts for the same action are coalesced (one keyboard).

**Config** (`config.toml`):

```toml
[features]
permission_mode = "ask"            # or "bypass"
```

Do **not** set `GROK_PERMISSION_MODE=always-approve` on LaunchAgents for the same reason.

**Setup TUI** asks once on `acpbot setup`.

**Slash commands:**

| Command | Scope |
|---|---|
| `/permissions` | Status + **Ask** / **Bypass** buttons (topic = this session; lobby = default + config.toml) |
| `/permissions ask\|bypass` | This topic only |
| `/permissions default ask\|bypass` | New topics — writes `config.toml` + `state_dir/permission-mode.json` |

Changing a topic’s policy re-ensures the agent slot.

| Field | Meaning |
|---|---|
| **Mode** | Permission / plan mode — Codex/Claude `session.modes`, OpenCode config `mode`, or Grok built-in `default`/`plan`/`ask` |
| **Effort** | Reasoning effort when advertised — e.g. Grok `high`/`medium`/`low` |

### Grok Build (source of truth)

From [xai-org/grok-build](https://github.com/xai-org/grok-build):

| Wire surface | Meaning |
|---|---|
| `_meta["x.ai/sessionConfig"]` options with `category: "mode"` | **Reasoning effort** only (`high`/`medium`/`low`…) — not permission mode |
| `session/new.modes` | **Not set** (NewSessionResponse is models + meta only) |
| `session/set_mode` | Real session modes: **`default`**, **`plan`**, **`ask`** (`SessionMode` in `xai-grok-tools`) |
| `current_mode_update` | Emitted when plan/default/ask changes |

acpbot seeds Grok’s mode catalog as `default` / `plan` / `ask` so `/mode`, `/plan`, and `/build` work. Effort stays on `/effort`.

## Modes (plan / build)

| Command | Intent |
|---|---|
| `/plan` | Plan / read-only-ish mode |
| `/build` | Build / tools-on mode |
| `/mode` | Picker or `/mode <id>` / toggle |

Modes come from:

1. ACP `session.modes` / `session/set_mode` (Codex, Claude)
2. ACP `configOptions` with id/category `"mode"` (OpenCode: `build` / `plan`)

Reasoning effort is **not** a permission mode — use `/effort` when the agent advertises it.

### Plan exit approval (Grok)

When the agent finishes a plan it calls **`exit_plan_mode`**. acpbot always treats that as an operator decision:

1. Telegram shows **Approve / Reject** (even if `permission_mode = "bypass"`)
2. Approve → continue into build (or your next instruction); Reject → stay in plan

If the agent auto-cancels plan exit without a client permission (misconfigured yolo), the worker **fallback** posts `plan.md` (when found) and tells you to run **`/build`** or keep planning.

## Effort (reasoning)

| Command | Intent |
|---|---|
| `/effort` | Picker of advertised levels (ids only, e.g. `high` / `medium` / `low`) |
| `/effort <level>` | Set directly |

Sources depend on the agent:

- **Grok Build** — session config under `_meta` (category often labeled `"mode"` in the agent payload; treated as **effort**)
- **OpenCode** — `configOptions` with id `effort` / category `thought_level` when the model has variants

Setting uses ACP `session/set_mode` or `session/set_config_option` as appropriate. UI shows level **ids**, not marketing labels.

## Skills

acpbot ships **telegram** and **schedules**. Install globally so every agent CLI sees them:

```bash
acpbot skills install   # once — not on every worker start
```

Works from the release binary (skills are embedded). Telegram **`/skills`** also discovers them without a global install.

`/skills` (topic) discovers collections from:

- Bundled skills root (package `skills/` or materialised under `~/.local/share/acpbot/bundled-skills/`)
- Session cwd (`.agents/skills`, `.grok/skills`, …)
- `[skills].roots` / `ACPBOT_SKILL_ROOTS` (extra dirs)
- Defaults under `$HOME`: `.grok/skills`, `.grok/bundled/skills`, `.agents/skills`, `.claude/skills`

Pick a skill, then send a prompt that includes it for the agent. Full write-up: [Skills](/docs/skills).

## acp-host notes

acp-host is **required** (worker fails boot without a live host socket):

- Agent stdio lives in the host process
- Worker restart does not kill agents
- Host SIGTERM disposes all agent processes
- `/agent` changes go through host ensure + optional respawn RPCs

See [Architecture](/docs/architecture).
