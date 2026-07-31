# Scratch pad

## Status board (agent)

Edit `public/status.json` to update the live board on the React app.

```json
{
  "state": "online|busy|away|offline",
  "message": "Human-readable status line",
  "by": "agent",
  "updatedAt": "ISO-8601 timestamp"
}
```

UI polls every ~2.5s.

## Peer chat

- UI: Peer chat card on the demo page
- WS: `server/chat-server.ts` on `:4097`, proxied at `/ws` via Vite
- Run: `bun run dev` (starts chat + Vite)
- Tailscale: https://mac-mini.taile07e4.ts.net/

Open two tabs/devices, set names, chat.
