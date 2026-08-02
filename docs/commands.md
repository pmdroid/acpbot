# Slash commands

Commands are registered in `src/core/commands.ts`.  
**Slash input never goes to the agent.** Lobby commands typed inside a topic get a short “use the main chat” reply.

## Lobby (root private chat)

| Command | Description |
|---|---|
| `/ping` | Liveness → `pong` |
| `/new` | Create a session (repo picker, or `/new <repo> <name>`) |
| `/sessions` | List sessions from the acpbot store |
| `/help` | Lobby help |

## Topic (session)

| Command | Description |
|---|---|
| `/cancel` | Stop the current turn **and clear the prompt queue** (session kept) |
| `/steer <text>` | **Interrupt** the current turn and inject guidance now |
| `/queue` | List messages waiting until the current turn ends |
| `/unqueue` | Remove queued msgs: bare = last · `<n>` · `all` |
| `/status` | Context dump: agent, launch, mode, model, effort, cwd, MCP |
| `/model` | LLM picker buttons, or `/model <value>` |
| `/effort` | Reasoning effort picker, or `/effort <level>` |
| `/agent` | Switch agent process (respawn), or `/agent <id>` |
| `/mode` | Session mode picker (plan/build/ask), or `/mode <id>` / toggle |
| `/permissions` | Tool policy: `/permissions ask|bypass` (topic) or `default ask|bypass` (new topics) |
| `/plan` | Switch to plan mode (read-only-ish) |
| `/build` | Switch to build/code mode (tools on) |
| `/skills` | Pick a skill, then send a prompt |
| `/mcp` | Remote MCP registry + OAuth (see below) |
| `/help` | Topic help (includes queue vs steer notes) |

### Queue vs steer (while a turn is busy)

| Operator input | Effect |
|---|---|
| Free-text / media | **Queued** (FIFO). Runs **after** the current turn ends. Does **not** interrupt. Ack shows a **Remove** button. |
| `/steer <text>` | **Interrupts** the in-flight turn, then starts a new turn with that text. Existing queue is **kept** and drains after the steer turn. |
| `/queue` | List waiting items (preview + index). |
| `/unqueue` / `/unqueue <n>` / `/unqueue all` | Remove last / 1-based index / all. |
| **Remove** on the queue ack | Remove that one item. |
| Delete your own Telegram message | **Not supported** — Bot API does not notify deletes. Use Remove or `/unqueue`. |
| `/cancel` | Abort turn **and** clear the whole queue. |

Cap: 32 items per session (oldest dropped when full).

### `/mcp` subcommands

| Usage | Effect |
|---|---|
| `/mcp status` | List configured gateways for this repo |
| `/mcp add <id> <url>` | Register remote MCP (id + URL in repo only) |
| `/mcp remove <id>` | Remove registry entry |
| `/mcp auth <id>` | Start OAuth (tappable authorize URL) |
| `/mcp code <callback-url>` | Paste-code fallback (full URL preferred) |
| `/mcp code <code> <id>` | Bare code last resort |

Tokens are stored under `state_dir` (`mcp-oauth/`), never in the repo. Full flow: [oauth.md](oauth.md).

## Telegram menu

On startup acpbot clears stale `setMyCommands` scopes (default + private, `en`) and registers the command menu from the registry so operators see lobby + topic commands in Telegram’s `/` UI.

## Non-command input

| Input | Handling |
|---|---|
| Plain text in topic (idle) | ACP prompt turn |
| Plain text in topic (turn busy) | Enqueued until turn ends (see **Queue vs steer**) |
| Photo / document | Saved to `.acpbot-inbox/` (or ACP attach if enabled) + prompt (or queue if busy) |
| Voice | STT when configured, then prompt (or queue if busy) |
| Callback button | Permission / question / mode / effort / model / agent pickers; **Remove** on queue acks |

## Wrong scope

- Lobby command in a topic → “open the main chat”
- Topic command in lobby → “use a session topic”
- Unknown command → scope-aware help hint
