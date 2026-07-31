import { useCallback, useEffect, useState } from "react";

export type BoardStatus = {
  state: "online" | "busy" | "away" | "offline" | string;
  message: string;
  by?: string;
  updatedAt?: string;
};

const POLL_MS = 2500;

function formatWhen(iso?: string): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function StatusBoard() {
  const [status, setStatus] = useState<BoardStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/status.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BoardStatus;
      setStatus(data);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const state = status?.state ?? "…";

  return (
    <section className="card status-board" data-state={status?.state ?? "unknown"}>
      <div className="status-head">
        <h2>Live status</h2>
        <span className={`status-pill status-${String(state).toLowerCase()}`}>{state}</span>
      </div>

      {error && !status ? (
        <p className="muted">Could not load status: {error}</p>
      ) : (
        <>
          <p className="status-message">{status?.message ?? "Loading…"}</p>
          <p className="muted status-meta">
            by <strong>{status?.by ?? "—"}</strong>
            {" · "}
            updated {formatWhen(status?.updatedAt)}
            {lastFetch && (
              <>
                {" · "}
                polled {lastFetch.toLocaleTimeString()}
              </>
            )}
          </p>
        </>
      )}

      <p className="muted status-hint">
        Agent: edit <code>public/status.json</code> from chat — this card refreshes every{" "}
        {POLL_MS / 1000}s.
      </p>
      <button type="button" className="ghost" onClick={() => void load()}>
        Refresh now
      </button>
    </section>
  );
}
