---
name: telegram-update
description: Send mid-work progress updates to the operator on Telegram via the tacp MCP update tool.
---

# Telegram updates (tacp)

You are in a **tacp** Telegram topic. The operator cannot see your thinking.
When work takes a while, use the host MCP tool **`update`** (server `tacp`) so they
get a short progress ping **while you continue working**.

## Tools

```
update({ text: "…" })           // progress ping (preferred for status)
telegram_send({ text: "…" })    // general mid-turn message (links, notes)
speak({ text: "…" })            // voice note only when voice is clearly wanted
```

## When to call `update`

- Multi-step work where the next step may take >30s
- You finished a milestone and are starting the next
- Something failed and you are retrying
- The user asked to “keep me posted”

## When not to

- Every tiny tool call
- The final answer (use your normal assistant reply)
- Empty “working…” spam

## Style

1–3 short sentences. Lead with what happened / what is next. No markdown walls.
