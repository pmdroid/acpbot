# Spooky's Telegram agent bridge

Based on pmdroid/acpbot, source revision 6f0059d1a10859ee4659efb1a6d44d0b48d40ff1.

Bot: @Agent_control_spooky_bot. Paired owner: @SpookyPike.

For selective notifications and blocking Telegram questions from an existing
MiMo/Codex conversation, use [SELECTIVE_MCP.md](SELECTIVE_MCP.md).
The instructions below describe the earlier bot-managed-session mode.

## Use

Each Telegram topic is one persistent agent session. Topic titles use
`Codex · Session name` or `MiMo · Session name`; switching the agent updates
the title. Replies in that topic continue its session.

In the bot's root chat, `/new playground my-task` creates a session using
MiMo by default. Inside the topic, `/agent codex` switches to Codex and
`/agent mimo` switches to MiMo. Use separate topics to keep their contexts
independent. `/cancel` cancels current work; `/steer your guidance` interrupts
and supplies new input. Normal text while busy queues the next turn.

The only configured workspace is `/data/projects/playground`. Add another
project with `acpbot repo add short-name /absolute/path/to/project`.

The bridge injects MCP tools for progress (`update`), messages
(`telegram_send`), images (`telegram_send_photo`), and attachments
(`telegram_send_file`). Ask the agent to send a screenshot, report, or file.
The shared `telegram` skill instructs agents to report major milestones.

## Installation

- Executable: `~/.local/bin/acpbot`
- Private configuration: `~/.config/acpbot/config.toml` (0600)
- State/session routing: `~/.local/share/acpbot/`
- Pinned Codex adapter: `~/.local/share/acpbot/runtime/`
- Codex launcher: `~/.local/bin/acpbot-codex` (uses installed Codex CLI)
- Shared skill: `~/.agents/skills/telegram/SKILL.md`
- Services: `acpbot-host.service` and `acpbot.service` (systemd user)

The bot token is outside this repository. Do not copy it into source or logs.
Only the paired Telegram account controls sessions. Permissions use `ask`.
Voice transcription/speech are disabled. The computer must be awake and online. User lingering is enabled so the services also survive logout and start at boot.

## Service commands

```sh
acpbot status
acpbot restart
acpbot stop
journalctl --user -u acpbot-host -u acpbot -f
```

## Local adaptations

1. Pairing/setup messages work before Threaded Mode is enabled. Agent work
   remains gated until Telegram reports topics available.
2. MiMo/Codex use their saved CLI login, avoiding unnecessary interactive
   authentication at ACP initialization.
3. Topic titles include the agent and refresh when switching agents.

## Verification

Both agents passed real ACP initialization, session creation, and a harmless
prompt. Both completed a turn through the real daemon/host and delivered
responses in Telegram topics. Both agents also called the injected Telegram MCP message tool successfully. The outbound API delivered a PNG and text file; a real inbound user photo reached Codex and was opened successfully.
Topic creation and the attachment checks used the real Telegram Bot API;
the diagnostic prompt was submitted locally through the daemon handler.

56 targeted regression tests passed. Build passed. Upstream full typecheck
has existing errors; normalized diagnostic comparison found no new errors
from these adaptations.

`scripts/verify-local-agents.py` checks ACP without Telegram.
`scripts/verify-telegram.ts` sends diagnostic messages/files to the paired bot;
run it only with the Telegram worker stopped, then restart that worker.

These are bridge-managed sessions. Existing CLI conversations can now use the
separate selective MCP mode documented in SELECTIVE_MCP.md; it exchanges
messages at explicit tool calls without taking over their execution.

Do not run diagnostics against a topic while the operator is chatting in it.
