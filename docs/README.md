# tacp documentation

Operator and architecture docs for **tacp** — Telegram as a control surface for ACP coding agents.

## Start here

1. [Getting started](getting-started.md) — bot, `.env`, first topic
2. [Configuration](configuration.md) — every env var
3. [Commands](commands.md) — lobby vs topic slash surface

## How it works

| Doc | Topic |
|---|---|
| [Architecture](architecture.md) | Worker, acp-host, sockets, store layout |
| [Agents](agents.md) | Built-in agents, `/model`, `/agent` |
| [MCP](mcp.md) | Built-in `tacp` tools, per-repo servers, profiles |
| [Worker API](worker-api.md) | Unix HTTP API MCP → Telegram |
| [Schedules](schedules.md) | Durable jobs under `.tacp/schedules/` |
| [OAuth](oauth.md) | Remote MCP auth (PKCE + DCR) |

## Ideas / future

- [Agent host keepalive](ideas/agent-host-keepalive.md) — long-lived agent owner (MVP implemented)

## Root README

High-level overview and quick start: [../README.md](../README.md).
