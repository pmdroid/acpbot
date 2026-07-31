import { useEffect, useRef, useState } from "react";

const SRC = "/polestar-whispers.mp3";
const TITLE = "Polestar Whispers";
const SUBTITLE = "Yuri's got a vision · metal in motion";

const LYRIC_SNIPPETS = [
  "Yuri's got a vision, a spark in his eye",
  "Metal in motion reaching for the sky",
  "Polestar whispers his name — a legend in the game",
  "Yuri, Yuri, what a guy — makes the cars fly oh so high",
  "Sleek and electric, a future so bright",
  "Yuri's design is pure delight",
];

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function FancyPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(0.85);
  const [snippet, setSnippet] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = vol;
  }, [vol]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setSnippet((i) => (i + 1) % LYRIC_SNIPPETS.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, [playing]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      a.pause();
      setPlaying(false);
    }
  }

  function onSeek(value: number) {
    const a = audioRef.current;
    if (!a || !Number.isFinite(value)) return;
    a.currentTime = value;
    setT(value);
  }

  const pct = dur > 0 ? (t / dur) * 100 : 0;

  return (
    <section className={`card fancy-player ${playing ? "is-playing" : ""}`} aria-label="Audio player">
      <audio
        ref={audioRef}
        src={SRC}
        preload="metadata"
        onLoadedMetadata={(e) => {
          setDur(e.currentTarget.duration || 0);
          setReady(true);
        }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onEnded={() => {
          setPlaying(false);
          setT(0);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />

      <div className="fp-top">
        <div className={`fp-disc ${playing ? "spin" : ""}`} aria-hidden>
          <div className="fp-disc-hole" />
          <div className="fp-eq">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>
        </div>

        <div className="fp-meta">
          <p className="fp-label">now spinning</p>
          <h2>{TITLE}</h2>
          <p className="muted fp-sub">{SUBTITLE}</p>
          <p className="fp-lyric" key={snippet}>
            “{LYRIC_SNIPPETS[snippet]}”
          </p>
        </div>
      </div>

      <div className="fp-controls">
        <button
          type="button"
          className="fp-play"
          onClick={toggle}
          disabled={!ready && dur === 0}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>

        <div className="fp-scrub">
          <div className="fp-times">
            <span>{formatTime(t)}</span>
            <span>{formatTime(dur)}</span>
          </div>
          <input
            className="fp-range"
            type="range"
            min={0}
            max={dur || 0}
            step={0.1}
            value={t}
            onChange={(e) => onSeek(Number(e.target.value))}
            style={{ ["--pct" as string]: `${pct}%` }}
            aria-label="Seek"
          />
        </div>

        <label className="fp-vol">
          <span aria-hidden>🔊</span>
          <input
            className="fp-range fp-vol-range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={vol}
            onChange={(e) => setVol(Number(e.target.value))}
            style={{ ["--pct" as string]: `${vol * 100}%` }}
            aria-label="Volume"
          />
        </label>
      </div>
    </section>
  );
}
