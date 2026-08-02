# Agents, models, and modes

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

`/status` shows **Agent**, **Launch**, **Mode**, **Model**, and **Effort** (when advertised) as distinct fields.

## Modes (permission)

| Command | Intent |
|---|---|
| `/plan` | Plan / read-only-ish mode |
| `/build` | Build / tools-on mode |
| `/mode` | Picker or `/mode <id>` / toggle |

Modes come from:

1. ACP `session.modes` / `session/set_mode` (Codex, Claude)
2. ACP `configOptions` with id/category `"mode"` (OpenCode: `build` / `plan`)

Reasoning effort is **not** a permission mode — use `/effort` when the agent advertises it.

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

acpbot ships **telegram** and **schedules** under package [`skills/`](../skills/). Install globally so every agent CLI sees them:

```bash
bun run skills:install   # once — not on every worker start
```

`/skills` (topic) discovers collections from:

- Package `skills/` (always on `skillRoots`)
- Session cwd (`.agents/skills`, `.grok/skills`, …)
- `[skills].roots` / `ACPBOT_SKILL_ROOTS` (extra dirs)
- Defaults under `$HOME`: `.grok/skills`, `.grok/bundled/skills`, `.agents/skills`, `.claude/skills`

Pick a skill, then send a prompt that includes it for the agent. Full write-up: [skills.md](skills.md).

## acp-host notes

acp-host is **required** (worker fails boot without a live host socket):

- Agent stdio lives in the host process
- Worker restart does not kill agents
- Host SIGTERM disposes all agent processes
- `/agent` changes go through host ensure + optional respawn RPCs

See [architecture.md](architecture.md).
