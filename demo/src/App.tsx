import { useMemo, useState } from "react";
import FancyPlayer from "./FancyPlayer";
import PeerChat from "./PeerChat";
import StatusBoard from "./StatusBoard";
import "./App.css";

type Idea = {
  id: string;
  title: string;
  blurb: string;
};

const STARTER_IDEAS: Idea[] = [
  {
    id: "counter",
    title: "Mood counter",
    blurb: "Tap + / − and watch the vibe label change.",
  },
  {
    id: "todo",
    title: "Quick todos",
    blurb: "Add a few tasks, check them off, clear done.",
  },
  {
    id: "palette",
    title: "Color flash",
    blurb: "Shuffle accent colors on every click.",
  },
];

function moodLabel(n: number): string {
  if (n <= -3) return "icy";
  if (n < 0) return "chilly";
  if (n === 0) return "neutral";
  if (n < 3) return "warm";
  return "on fire";
}

export default function App() {
  const [count, setCount] = useState(0);
  const [todos, setTodos] = useState<string[]>(["Ship React demo", "Open Tailscale link"]);
  const [draft, setDraft] = useState("");
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [hue, setHue] = useState(330);
  const [selected, setSelected] = useState<string | null>(null);

  const mood = useMemo(() => moodLabel(count), [count]);

  function addTodo() {
    const t = draft.trim();
    if (!t) return;
    setTodos((prev) => [...prev, t]);
    setDraft("");
  }

  return (
    <div
      className="page"
      style={{
        ["--accent" as string]: `hsl(${hue} 95% 55%)`,
      }}
    >
      <header className="hero">
        <p className="eyebrow">tacp · chunky pink</p>
        <h1>Hello from the Mac mini</h1>
        <p className="lede">
          Funky pink playground over Tailscale — poke the toys, chat with peers, update status from
          the agent.
        </p>
        <figure className="hero-photo">
          <img
            src="/hero-photo.jpg"
            alt="Photo added from Telegram"
            width={2560}
            height={1396}
            loading="eager"
          />
          <figcaption>fresh drop from the inbox ✨</figcaption>
        </figure>
      </header>

      <div className="status-wrap">
        <FancyPlayer />
      </div>

      <div className="status-wrap">
        <StatusBoard />
      </div>

      <div className="status-wrap">
        <PeerChat />
      </div>

      <section className="grid">
        <article className="card">
          <h2>Mood counter</h2>
          <p className="muted">Currently: <strong>{mood}</strong></p>
          <div className="row">
            <button type="button" onClick={() => setCount((c) => c - 1)}>−</button>
            <span className="count">{count}</span>
            <button type="button" onClick={() => setCount((c) => c + 1)}>+</button>
          </div>
        </article>

        <article className="card">
          <h2>Quick todos</h2>
          <ul className="todos">
            {todos.map((t) => (
              <li key={t}>
                <label>
                  <input
                    type="checkbox"
                    checked={!!done[t]}
                    onChange={() => setDone((d) => ({ ...d, [t]: !d[t] }))}
                  />
                  <span className={done[t] ? "strike" : undefined}>{t}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTodo()}
              placeholder="New todo…"
            />
            <button type="button" onClick={addTodo}>Add</button>
          </div>
        </article>

        <article className="card">
          <h2>Color flash</h2>
          <p className="muted">Accent hue: {hue}°</p>
          <button type="button" onClick={() => setHue(Math.floor(Math.random() * 360))}>
            Shuffle color
          </button>
        </article>
      </section>

      <section className="card ideas">
        <h2>Ideas you can pick next</h2>
        <p className="muted">Tell the agent which one to build.</p>
        <div className="idea-list">
          {STARTER_IDEAS.map((idea) => (
            <button
              key={idea.id}
              type="button"
              className={selected === idea.id ? "idea selected" : "idea"}
              onClick={() => setSelected(idea.id)}
            >
              <strong>{idea.title}</strong>
              <span>{idea.blurb}</span>
            </button>
          ))}
        </div>
        {selected && (
          <p className="pick">
            Selected: <code>{selected}</code> — reply with that id to extend it.
          </p>
        )}
      </section>
    </div>
  );
}
