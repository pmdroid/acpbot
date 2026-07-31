# Slash commands

Commands are registered in `src/core/commands.ts`.  
**Slash input never goes to the agent.** Lobby commands typed inside a topic get a short “use the main chat” reply.

## Lobby (root private chat)

| Command | Description |
|---|---|
| `/ping` | Liveness → `pong` |
| `/new` | Create a session (repo picker, or `/new <repo> <name>`) |
| `/sessions` | List sessions from the tacp store |
| `/help` | Lobby help |

## Topic (session)

| Command | Description |
|---|---|
| `/cancel` | Stop the current turn (keeps the session) |
| `/status` | Context dump: agent, launch, mode, model, cwd, MCP |
| `/model` | LLM picker buttons, or `/model <value>` |
| `/agent` | Switch agent process (respawn), or `/agent <id>` |
| `/mode` | Mode picker, or `/mode <id>` / toggle |
| `/plan` | Switch to plan mode (read-only-ish) |
| `/build` | Switch to build/code mode (tools on) |
| `/skills` | Pick a skill, then send a prompt |
| `/mcp` | Remote MCP registry + OAuth (see below) |
| `/help` | Topic help |

### `/mcp` subcommands

| Usage | Effect |
|---|---|
| `/mcp status` | List configured gateways for this repo |
| `/mcp add <id> <url>` | Register remote MCP (id + URL in repo only) |
| `/mcp remove <id>` | Remove registry entry |
| `/mcp auth <id>` | Start OAuth (tappable authorize URL) |
| `/mcp code <callback-url>` | Paste-code fallback (full URL preferred) |
| `/mcp code <code> <id>` | Bare code last resort |

Tokens are stored under `TACP_ACPX_STATE_DIR`, never in the repo. Full flow: [oauth.md](oauth.md).

## Telegram menu

On startup tacp clears stale `setMyCommands` scopes (default + private, `en`) and registers the command menu from the registry so operators see lobby + topic commands in Telegram’s `/` UI.

## Non-command input

| Input | Handling |
|---|---|
| Plain text in topic | ACP prompt turn |
| Photo / document | Saved to `.tacp-inbox/` (or ACP attach if enabled) + prompt |
| Voice | STT when configured, then prompt |
| Callback button | Permission / question / mode / model / agent pickers |

## Wrong scope

- Lobby command in a topic → “open the main chat”
- Topic command in lobby → “use a session topic”
- Unknown command → scope-aware help hint
