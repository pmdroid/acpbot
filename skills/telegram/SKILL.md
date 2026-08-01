---
name: telegram
description: >
  Operator messaging on acpbot (Telegram topics): progress updates, mid-turn text,
  photos, files, and voice. Use whenever you need to reach the human on Telegram
  beyond the final reply — status pings, attachments, or spoken notes.
---

# Telegram (acpbot)

You are in a **acpbot** Telegram topic. The operator only sees what you send on Telegram
(normal reply text, plus the tools below). They do not see your thinking.

Host MCP server: **`acpbot`**. Call tools by name (clients may show them as `tacp__…`).

## Tool map

| Tool | When |
|------|------|
| **`update`** | Edit the live “⏳ working…” bubble while work continues (one message, not spam) |
| **`telegram_send`** | Mid-turn text that is not a status ping (link, note, intermediate result) |
| **`telegram_send_photo`** | Image the operator should see (screenshot, plot, generated picture) |
| **`telegram_send_file`** | Non-image file (log, PDF, patch, archive) |
| **`speak`** | Voice note when they asked for spoken/TTS, or a short audible confirm |

Final answers still go in your **normal assistant reply**. Tools are for mid-work
or media the reply alone cannot deliver well.

## Text

```
update({ text: "Migrated schema; running tests…" })
telegram_send({ text: "Preview: https://…" })
```

- **`update`**: 1–3 short sentences; lead with what happened / next step. Edits the single working bubble; the host deletes it when the final reply lands.
- **`telegram_send`**: permanent mid-turn messages (links, intermediate results) — not the working bubble.
- Do **not** use either for the final answer (use the normal reply).
- Do **not** ping on every tiny tool call.

## Photos and files

```
telegram_send_photo({ path: "images/out.png", caption?: "…" })
telegram_send_file({ path: "dist/report.pdf", caption?: "…", filename?: "report.pdf" })
```

- Paths must be **inside the session repo** (relative to repo root, or absolute under it).
- Prefer **photo** for images meant to view inline; **file** for everything else.
- Limits are roughly photo ~10MB, file ~50MB.
- If the file lives only under the agent session folder, **copy it into the repo first**, then send.

## Voice

```
speak({ text: "Short natural line for the voice note." })
```

- Only when the user wants voice/spoken/TTS, or a brief audible confirm is clearly better.
- Keep text concise and speakable (no markdown walls).
- Still send readable text when they need to read something.
- Do **not** call `speak` on every message.

## Worker requirement

Outbound tools need the **acpbot worker** running (Telegram bot + worker API).
If a tool says the worker API is unreachable, tell the operator the worker is down;
do not invent a fake “sent” status.

## Related

For delayed or recurring work, use the **schedules** skill (`schedule_create` / `list` / `cancel` / `run_now`).
