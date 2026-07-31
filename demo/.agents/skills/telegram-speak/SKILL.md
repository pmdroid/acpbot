---
name: telegram-speak
description: When the user wants a spoken/voice reply on Telegram (tacp), call the speak MCP tool (or use a speak marker). Do not assume every reply is voiced.
---

# Telegram speak (tacp)

You are chatting via **tacp** (Telegram). Text is always delivered. **Voice is opt-in.**

## When to speak

Only when the user asks for voice/spoken/TTS, or a short audible confirmation is clearly better than text alone.

## Preferred: MCP `speak` tool

tacp exposes a host MCP server named **tacp** with tool **`speak`**:

```
speak({ text: "Short natural line for the voice note." })
```

- Keep `text` concise and speakable (no markdown noise).
- Still send a normal text reply when the user needs to read something.
- Do **not** call `speak` on every message.

## Fallback: speak marker

If the tool is unavailable, end your message with:

```
Your normal reply here.

<<<speak>>>
```

- Empty body → tacp voices the **visible** reply text.
- Optional override (shorter line for TTS):

```
Here's a long written answer...

<<<speak>>>
Short spoken summary only.
```

## Do not

- Put `<<<speak>>>` or call `speak` on every reply.
- Invent non-existent tools beyond `speak` / `tts` for voice.
