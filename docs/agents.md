# Agents, models, and modes

## Built-in agent registry

Defined in `src/acp/agent-launch.ts`. The `/agent` picker **only lists agents whose required binaries are on `PATH`**.

| Id | Label | Launch | Requires |
|---|---|---|---|
| `grok-build` | grok | `grok agent stdio` | `grok` |
| `claude` | claude | `npx -y @agentclientprotocol/claude-agent-acp` | `npx`, `claude` |
| `codex` | codex | `npx -y @agentclientprotocol/codex-acp` | `npx`, `codex` |
| `opencode` | opencode | `opencode acp` | `opencode` |

**Aliases** (normalized before launch):

| Input | Canonical |
|---|---|
| `grok`, `xai`, `grok-build` | `grok-build` |
| `claude-code`, `claude-acp` | `claude` |
| `opencode-ai`, `open-code` | `opencode` |

### Overrides

```bash
TACP_DEFAULT_AGENT=grok-build
TACP_AGENT_COMMAND_JSON='{"grok-build":{"command":"grok","args":["agent","stdio"]}}'
```

JSON overrides merge on top of the built-in registry (same shape: `command` + `args`).

### Backends

| `TACP_AGENT_BACKEND` | Behavior |
|---|---|
| `echo` | No child process; canned echo for Telegram path demos |
| `real` | Spawn via ACP SDK host (or acp-host slots) |

## `/agent` — switch process mid-session

- Shows a picker of available agents (+ any ids from `TACP_AGENT_COMMAND_JSON`)
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

`/status` shows **Agent**, **Launch**, **Mode**, and **Model** as distinct fields.

## Modes

| Command | Intent |
|---|---|
| `/plan` | Plan / read-only-ish mode |
| `/build` | Build / tools-on mode |
| `/mode` | Picker or `/mode <id>` / toggle |

Modes use ACP session mode APIs when the agent advertises them.

## Skills

tacp ships **telegram** and **schedules** under package [`skills/`](../skills/). Install globally so every agent CLI sees them:

```bash
bun run skills:install
# also runs on worker start (skip: TACP_SKIP_SKILL_INSTALL=1)
```

`/skills` (topic) discovers collections from:

- Package `skills/` (always on `skillRoots`)
- Session cwd (`.agents/skills`, `.grok/skills`, …)
- `TACP_SKILL_ROOTS` (extra dirs)
- Defaults under `$HOME`: `.grok/skills`, `.grok/bundled/skills`, `.agents/skills`, `.claude/skills`

Pick a skill, then send a prompt that includes it for the agent. Full write-up: [skills.md](skills.md).

## acp-host notes

When `TACP_ACP_HOST=1` (or the socket already exists):

- Agent stdio lives in the host process
- Worker restart does not kill agents
- Host SIGTERM disposes all agent processes
- `/agent` changes go through host ensure + optional respawn RPCs

See [architecture.md](architecture.md) and [ideas/agent-host-keepalive.md](ideas/agent-host-keepalive.md).
