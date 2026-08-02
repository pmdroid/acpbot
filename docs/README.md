# acpbot documentation

Operator and architecture docs for **acpbot** — Telegram as a control surface for ACP coding agents.

## Start here

1. [Getting started](getting-started.md) — bot, config, pair, first topic
2. [Pairing](pairing.md) — CLI operator approve flow
3. [Configuration](configuration.md) — `config.toml` reference (paths, speech, OAuth)
4. [Commands](commands.md) — lobby vs topic slash surface

## How it works

| Doc | Topic |
|---|---|
| [Architecture](architecture.md) | Worker, acp-host, sockets, store layout |
| [Agents](agents.md) | Built-in agents, `/model`, `/agent` |
| [MCP](mcp.md) | Built-in `acpbot` tools, per-repo servers, profiles |
| [Worker API](worker-api.md) | Unix HTTP API MCP → Telegram |
| [Schedules](schedules.md) | Durable delayed/recurring jobs + host ticker |
| [Skills](skills.md) | Bundled `telegram` + `schedules` skills, global install |
| [OAuth](oauth.md) | Remote MCP auth (PKCE + DCR) |

## Root README

High-level overview and quick start: [../README.md](../README.md).
