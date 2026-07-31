---
name: telegram-speak
description: When the user wants a spoken/voice reply on Telegram (tacp), call the speak MCP tool. It sends a real voice note — do not use markers instead.
---

# Telegram speak (tacp)

You are chatting via **tacp** (Telegram). Text is always delivered. **Voice is opt-in.**

## When to speak

Only when the user asks for voice/spoken/TTS, or a short audible confirmation is clearly better than text alone.

## How: MCP `speak` tool (required path)

tacp exposes host MCP server **tacp** with tool **`speak`**:

```
speak({ text: "Short natural line for the voice note." })
```

- This **synthesizes TTS and sends a Telegram voice note immediately**.
- Do **not** also add `<<<speak>>>` markers — the tool is enough.
- Keep `text` concise and speakable (no markdown).
- Still send a normal text reply when the user needs to read something.
- Do **not** call `speak` on every message.

## Fallback only if speak tool is missing

If no `speak` tool is available, you may end with:

```
<<<speak>>>
optional short line
```

## Do not

- Tell the user you cannot send voice when `speak` exists — call it.
- Put `<<<speak>>>` on every reply or together with a successful `speak` call.
