---
title: CLI chat hub
description: Multi-session terminal hub over acp-host — list, focus, prompt without Telegram.
order: 25
section: start
---

**`acpbot chat`** is a multi-session terminal hub that talks **only to acp-host**. You do not need the Telegram worker for chat.

```text
LibreChat / WebUI (later)     Telegram worker
           \                     /
            v                   v
              acp-host slots
                    ^
                    |
              acpbot chat (focus)
```

Many sessions can stay alive on the host; free text goes to the **one focused** session. Switching focus does not kill other sessions.

## Prerequisites

1. Config with at least one `[repos]` entry (`acpbot repo add …`)
2. Host running: `acpbot host` or `acpbot start --host`
3. Same `state_dir` / socket as the host

No `bot_token` required for chat.

## Commands

```bash
acpbot chat                      # interactive REPL
acpbot chat ls                   # list host + durable sessions
acpbot chat session <key>        # set focus (repo/name or #n)
acpbot chat -m "prompt"          # one-shot on focused session
acpbot chat session acpbot/main -m "hi"
acpbot chat --bypass -m "…"      # auto-allow tools (no TTY prompts)
```

### REPL

| Input | Effect |
|---|---|
| free text | Prompt the focused session |
| `/sessions` · `/ls` | List sessions (`*` = focus) |
| `/use <key\|#n>` | Change focus |
| `/new <repo> [name]` | Ensure `repo/name` and focus |
| `/status` | Focus + defaults |
| `/cancel` | Cancel in-flight turn |
| `/fresh` | New ACP conversation (history cleared; key kept) |
| `/exit` | Quit |

### Selectors

- Full key: `acpbot/main`, `acpbot/main--child`
- Index: `1`, `#2` (1-based, same order as `/sessions`)
- Unique leaf slug or name when unambiguous

Focus is stored in `$state_dir/chat-focus.json` (local to this machine; not shared with Telegram).

## Permissions

| Mode | When |
|---|---|
| **ask** (default on TTY) | Prompt y / a / n for tool permissions |
| **bypass** (`--bypass`) | Auto-allow tools (same risk profile as Telegram `/permissions bypass`) |

Non-TTY + ask fails closed (reject) so unattended scripts do not hang.

## Architecture notes

- Shared turn helper: `src/chat/turn.ts` (`streamTurn` / `promptText`) — also the base for the OpenAI gateway.
- Session helpers: `src/chat/sessions.ts`
- Host discovery: `list` NDJSON → client `listSlots()`
- Child worktrees / multi-agent from CLI: later milestones (`/spawn`)

## Related

- [Architecture](/docs/architecture) — host vs worker
- [Multi-agent](/docs/multi-agent) — spawn model (Telegram/MCP today)
- [Configuration](/docs/configuration) — repos, state_dir
