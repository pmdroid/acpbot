---
title: Documentation
description: Operator and architecture docs for acpbot — Telegram as a control surface for ACP coding agents.
order: 0
section: start
---

Operator and architecture docs for **acpbot** — Telegram as a control surface for ACP coding agents.

## Start here

1. [Getting started](/docs/getting-started) — release binary, setup, pair, first topic
2. [Pairing](/docs/pairing) — CLI operator approve flow
3. [Repos](/docs/repos) — `acpbot repo` manager + folder browser
4. [Configuration](/docs/configuration) — `config.toml` reference (paths, speech, OAuth)
5. [Commands](/docs/commands) — lobby vs topic slash surface

## How it works

| Doc | Topic |
|---|---|
| [Architecture](/docs/architecture) | Worker, acp-host, sockets, store layout |
| [Agents](/docs/agents) | Built-in agents, `/model`, `/agent` |
| [MCP](/docs/mcp) | Built-in `acpbot` tools, per-repo servers, profiles |
| [Worker API](/docs/worker-api) | Unix HTTP API MCP → Telegram |
| [Schedules](/docs/schedules) | Durable delayed/recurring jobs + host ticker |
| [Skills](/docs/skills) | Bundled `telegram` + `schedules` skills, global install |
| [OAuth](/docs/oauth) | Remote MCP auth (PKCE + DCR) |
| [Multi-agent](/docs/multi-agent) | Spawn child agents via MCP; worktrees + A2A |

## Source

High-level overview and install: [GitHub README](https://github.com/pmdroid/acpbot).
