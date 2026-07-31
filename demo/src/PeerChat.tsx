import { useEffect, useMemo, useRef, useState } from "react";

type Peer = { id: string; name: string; color: string };

type ChatLine =
  | { kind: "chat"; id: string; from: Peer; text: string; at: string }
  | { kind: "system"; id: string; text: string; at: string };

type ConnState = "connecting" | "open" | "closed";

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function defaultName(): string {
  const n = localStorage.getItem("peerchat-name");
  if (n?.trim()) return n.trim().slice(0, 24);
  return `guest-${Math.random().toString(36).slice(2, 6)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function PeerChat() {
  const [name, setName] = useState(defaultName);
  const [draft, setDraft] = useState("");
  const [conn, setConn] = useState<ConnState>("connecting");
  const [you, setYou] = useState<Peer | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retryTimer: number | undefined;

    function start() {
      if (closed) return;
      setConn("connecting");
      setError(null);
      ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        setConn("open");
        ws?.send(JSON.stringify({ type: "hello", name: nameRef.current }));
      };

      ws.onclose = () => {
        setConn("closed");
        setYou(null);
        setPeers([]);
        if (!closed) {
          setError("Disconnected — reconnecting…");
          retryTimer = window.setTimeout(start, 1500);
        }
      };

      ws.onerror = () => {
        setError("Connection issue — is the chat server running?");
      };

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        switch (msg.type) {
          case "welcome": {
            const me = msg.you as Peer;
            setYou(me);
            setPeers(msg.peers as Peer[]);
            setError(null);
            setLines((prev) => [
              ...prev,
              {
                kind: "system",
                id: crypto.randomUUID(),
                text: `Connected as ${me.name}`,
                at: new Date().toISOString(),
              },
            ]);
            break;
          }
          case "peer-join": {
            const peer = msg.peer as Peer;
            setPeers((p) => (p.some((x) => x.id === peer.id) ? p : [...p, peer]));
            break;
          }
          case "peer-leave": {
            const id = String(msg.id);
            setPeers((p) => p.filter((x) => x.id !== id));
            break;
          }
          case "peer-rename": {
            const peer = msg.peer as Peer;
            setPeers((p) => p.map((x) => (x.id === peer.id ? peer : x)));
            setYou((y) => (y && y.id === peer.id ? peer : y));
            break;
          }
          case "chat": {
            const from = msg.from as Peer;
            setLines((prev) => [
              ...prev,
              {
                kind: "chat",
                id: String(msg.id),
                from,
                text: String(msg.text),
                at: String(msg.at),
              },
            ]);
            break;
          }
          case "system": {
            setLines((prev) => [
              ...prev,
              {
                kind: "system",
                id: crypto.randomUUID(),
                text: String(msg.text),
                at: String(msg.at ?? new Date().toISOString()),
              },
            ]);
            break;
          }
          default:
            break;
        }
      };
    }

    start();
    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      ws?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  function applyName() {
    const next = name.trim().slice(0, 24) || defaultName();
    setName(next);
    localStorage.setItem("peerchat-name", next);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "rename", name: next }));
    }
  }

  function sendChat() {
    const text = draft.trim();
    if (!text || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "chat", text }));
    setDraft("");
  }

  const onlineCount = peers.length + (you ? 1 : 0);
  const peerLabel = useMemo(() => {
    if (conn === "connecting") return "Connecting…";
    if (conn === "closed") return "Disconnected";
    return `${onlineCount} online`;
  }, [conn, onlineCount]);

  return (
    <section className="card peer-chat">
      <div className="status-head">
        <h2>Peer chat</h2>
        <span
          className={`status-pill ${conn === "open" ? "status-online" : conn === "connecting" ? "status-busy" : "status-offline"}`}
        >
          {peerLabel}
        </span>
      </div>
      <p className="muted status-hint">
        Open this page on two devices (or tabs) on your tailnet. Everyone in the room sees messages
        in real time.
      </p>

      <div className="chat-layout">
        <aside className="chat-peers">
          <h3>Peers</h3>
          <ul>
            {you && (
              <li>
                <span className="peer-dot" style={{ background: you.color }} />
                <span>
                  {you.name} <em>(you)</em>
                </span>
              </li>
            )}
            {peers.map((p) => (
              <li key={p.id}>
                <span className="peer-dot" style={{ background: p.color }} />
                <span>{p.name}</span>
              </li>
            ))}
            {!you && peers.length === 0 && <li className="muted">No one yet</li>}
          </ul>
        </aside>

        <div className="chat-main">
          <div className="chat-lines" ref={listRef}>
            {lines.length === 0 && (
              <p className="muted chat-empty">Say hi — peers on the Tailscale link will see it.</p>
            )}
            {lines.map((line) =>
              line.kind === "system" ? (
                <div key={line.id} className="chat-system">
                  {line.text}
                </div>
              ) : (
                <div
                  key={line.id}
                  className={`chat-bubble ${you?.id === line.from.id ? "mine" : ""}`}
                >
                  <div className="chat-meta">
                    <strong style={{ color: line.from.color }}>{line.from.name}</strong>
                    <span>{formatTime(line.at)}</span>
                  </div>
                  <div className="chat-text">{line.text}</div>
                </div>
              ),
            )}
          </div>

          <div className="chat-compose">
            <div className="row chat-name-row">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={applyName}
                onKeyDown={(e) => e.key === "Enter" && applyName()}
                placeholder="Your name"
                maxLength={24}
                aria-label="Display name"
              />
              <button type="button" className="ghost" onClick={applyName}>
                Set name
              </button>
            </div>
            <div className="row">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendChat()}
                placeholder={conn === "open" ? "Message peers…" : "Connecting…"}
                disabled={conn !== "open"}
                maxLength={1000}
                aria-label="Chat message"
              />
              <button type="button" onClick={sendChat} disabled={conn !== "open" || !draft.trim()}>
                Send
              </button>
            </div>
            {error && <p className="muted chat-error">{error}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
