/**
 * Lightweight peer-room chat over WebSocket.
 * Clients on the Tailscale link join the same room and exchange messages.
 * The server only relays — it does not store history.
 */

const PORT = 4097;
const ROOM = "lobby";

type PeerInfo = { id: string; name: string; color: string };

type ClientData = {
  id: string;
  name: string;
  color: string;
  room: string;
};

type Inbound =
  | { type: "hello"; name?: string }
  | { type: "chat"; text: string }
  | { type: "rename"; name: string };

type Outbound =
  | { type: "welcome"; you: PeerInfo; peers: PeerInfo[] }
  | { type: "peer-join"; peer: PeerInfo }
  | { type: "peer-leave"; id: string }
  | { type: "peer-rename"; peer: PeerInfo }
  | { type: "chat"; id: string; from: PeerInfo; text: string; at: string }
  | { type: "system"; text: string; at: string };

const COLORS = ["#5eead4", "#fbbf24", "#a5b4fc", "#f472b6", "#34d399", "#fb923c", "#38bdf8"];

function randomColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

function cleanName(raw: unknown): string {
  const s = String(raw ?? "").trim().slice(0, 24);
  return s || `guest-${Math.random().toString(36).slice(2, 6)}`;
}

function send(ws: Bun.ServerWebSocket<ClientData>, msg: Outbound) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* closed */
  }
}

const clients = new Map<string, Bun.ServerWebSocket<ClientData>>();

function listPeers(room: string, exceptId?: string): PeerInfo[] {
  const peers: PeerInfo[] = [];
  for (const [id, ws] of clients) {
    if (ws.data.room !== room) continue;
    if (exceptId && id === exceptId) continue;
    peers.push({ id, name: ws.data.name, color: ws.data.color });
  }
  return peers;
}

function broadcast(room: string, msg: Outbound, exceptId?: string) {
  const raw = JSON.stringify(msg);
  for (const [id, ws] of clients) {
    if (ws.data.room !== room) continue;
    if (exceptId && id === exceptId) continue;
    try {
      ws.send(raw);
    } catch {
      /* ignore */
    }
  }
}

const server = Bun.serve<ClientData>({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, peers: clients.size, room: ROOM });
    }
    if (url.pathname === "/ws" || url.pathname === "/") {
      const upgraded = srv.upgrade(req, {
        data: {
          id: crypto.randomUUID(),
          name: "guest",
          color: COLORS[0]!,
          room: ROOM,
        },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response("peer chat ws — connect /ws", { status: 200 });
  },
  websocket: {
    open(ws) {
      clients.set(ws.data.id, ws);
    },
    message(ws, message) {
      let msg: Inbound;
      try {
        msg = JSON.parse(String(message)) as Inbound;
      } catch {
        return;
      }

      if (msg.type === "hello") {
        ws.data.name = cleanName(msg.name);
        ws.data.color = randomColor(ws.data.id + ws.data.name);
        const you: PeerInfo = {
          id: ws.data.id,
          name: ws.data.name,
          color: ws.data.color,
        };
        send(ws, { type: "welcome", you, peers: listPeers(ws.data.room, ws.data.id) });
        broadcast(ws.data.room, { type: "peer-join", peer: you }, ws.data.id);
        broadcast(ws.data.room, {
          type: "system",
          text: `${you.name} joined`,
          at: new Date().toISOString(),
        });
        return;
      }

      if (msg.type === "rename") {
        const prev = ws.data.name;
        ws.data.name = cleanName(msg.name);
        const peer: PeerInfo = {
          id: ws.data.id,
          name: ws.data.name,
          color: ws.data.color,
        };
        broadcast(ws.data.room, { type: "peer-rename", peer });
        if (prev !== peer.name) {
          broadcast(ws.data.room, {
            type: "system",
            text: `${prev} is now ${peer.name}`,
            at: new Date().toISOString(),
          });
        }
        return;
      }

      if (msg.type === "chat") {
        const text = String(msg.text ?? "").trim().slice(0, 1000);
        if (!text) return;
        const from: PeerInfo = {
          id: ws.data.id,
          name: ws.data.name,
          color: ws.data.color,
        };
        broadcast(ws.data.room, {
          type: "chat",
          id: crypto.randomUUID(),
          from,
          text,
          at: new Date().toISOString(),
        });
      }
    },
    close(ws) {
      clients.delete(ws.data.id);
      const peer: PeerInfo = {
        id: ws.data.id,
        name: ws.data.name,
        color: ws.data.color,
      };
      broadcast(ws.data.room, { type: "peer-leave", id: peer.id });
      broadcast(ws.data.room, {
        type: "system",
        text: `${peer.name} left`,
        at: new Date().toISOString(),
      });
    },
  },
});

console.log(`[chat] peer room on ws://127.0.0.1:${PORT}/ws  (${server.hostname}:${server.port})`);
