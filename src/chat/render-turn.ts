/**
 * Render streamTurn chunks to the terminal (full agent output).
 * Assistant text → stdout; thoughts/tools/status → stderr (so pipes stay clean).
 */
import type { ChatTurnChunk } from "./turn";

export type TurnRenderMode = "full" | "quiet";

export type TurnRenderOptions = {
  mode?: TurnRenderMode;
  /** Force color on/off (default: stderr is TTY). */
  color?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
};

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
};

export type TurnRenderer = {
  write(chunk: ChatTurnChunk): void;
  /** Call when the turn stream ends (ensures trailing newline on stdout). */
  finish(): void;
};

/**
 * Stateful renderer: tracks open thought/text blocks so tools don't glue to prose.
 */
export function createTurnRenderer(opts: TurnRenderOptions = {}): TurnRenderer {
  const mode = opts.mode ?? "full";
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const useColor =
    opts.color ??
    (Boolean((err as NodeJS.WriteStream).isTTY) ||
      Boolean(process.stderr.isTTY));

  let onStdoutLine = true; // at start of a line on stdout
  let thoughtOpen = false;
  let lastToolKey = "";

  const paint = (code: string, s: string) =>
    useColor ? `${code}${s}${ANSI.reset}` : s;

  const ensureStdoutNl = () => {
    if (!onStdoutLine) {
      out.write("\n");
      onStdoutLine = true;
    }
  };

  const closeThought = () => {
    if (thoughtOpen) {
      err.write(paint(ANSI.dim, "\n"));
      thoughtOpen = false;
    }
  };

  return {
    write(chunk: ChatTurnChunk) {
      if (mode === "quiet") {
        if (chunk.type === "text") {
          out.write(chunk.text);
          onStdoutLine = chunk.text.endsWith("\n");
        } else if (chunk.type === "error") {
          ensureStdoutNl();
          err.write(`[error] ${chunk.message}\n`);
        } else if (chunk.type === "done") {
          ensureStdoutNl();
        }
        return;
      }

      // full mode
      switch (chunk.type) {
        case "thought": {
          if (!thoughtOpen) {
            ensureStdoutNl();
            err.write(paint(ANSI.dim, "💭 "));
            thoughtOpen = true;
          }
          err.write(paint(ANSI.dim, chunk.text));
          break;
        }
        case "text": {
          closeThought();
          out.write(chunk.text);
          onStdoutLine = chunk.text.endsWith("\n");
          break;
        }
        case "tool": {
          closeThought();
          ensureStdoutNl();
          const id = chunk.toolCallId ?? "";
          const title = (chunk.title ?? "tool").trim() || "tool";
          const status = (chunk.status ?? "").toLowerCase();
          const key = `${id}|${title}|${status}`;
          // Dedupe identical consecutive updates (tool_call + tool_call_update spam)
          if (key === lastToolKey) break;
          lastToolKey = key;

          const icon = toolIcon(status);
          const statusLabel = status ? ` ${status}` : "";
          const kind = chunk.kind ? paint(ANSI.gray, ` · ${chunk.kind}`) : "";
          err.write(
            paint(ANSI.cyan, `${icon} ${title}`) +
              paint(ANSI.gray, statusLabel) +
              kind +
              "\n",
          );

          const detail = formatToolDetail(chunk);
          if (detail) {
            for (const line of detail.split("\n").slice(0, 12)) {
              err.write(paint(ANSI.gray, `    ${line}\n`));
            }
          }
          break;
        }
        case "error": {
          closeThought();
          ensureStdoutNl();
          err.write(paint(ANSI.red, `✗ ${chunk.message}\n`));
          break;
        }
        case "done": {
          closeThought();
          ensureStdoutNl();
          const ok =
            chunk.status === "completed" ||
            chunk.status === "end_turn" ||
            chunk.status === "ok";
          const line = chunk.stopReason
            ? `done · ${chunk.status} · ${chunk.stopReason}`
            : `done · ${chunk.status}`;
          err.write(
            paint(ok ? ANSI.green : ANSI.yellow, `${ok ? "✓" : "–"} ${line}\n`),
          );
          break;
        }
        default:
          break;
      }
    },
    finish() {
      closeThought();
      ensureStdoutNl();
    },
  };
}

/** Stream a whole turn through the renderer; returns final status. */
export async function renderTurnStream(
  chunks: AsyncIterable<ChatTurnChunk>,
  opts?: TurnRenderOptions,
): Promise<{ status: string; stopReason?: string }> {
  const r = createTurnRenderer(opts);
  let status = "failed";
  let stopReason: string | undefined;
  try {
    for await (const chunk of chunks) {
      r.write(chunk);
      if (chunk.type === "done") {
        status = chunk.status;
        stopReason = chunk.stopReason;
      }
    }
  } finally {
    r.finish();
  }
  return {
    status,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function toolIcon(status: string): string {
  if (!status) return "🔧";
  if (/complet|success|done|ok/.test(status)) return "✓";
  if (/fail|error|cancel|reject/.test(status)) return "✗";
  if (/pend|start|run|in_progress|progress/.test(status)) return "⏳";
  return "🔧";
}

function formatToolDetail(
  chunk: Extract<ChatTurnChunk, { type: "tool" }>,
): string {
  const parts: string[] = [];
  if (chunk.rawInput !== undefined) {
    parts.push(truncate(stringify(chunk.rawInput), 400));
  }
  if (chunk.rawOutput !== undefined && isInterestingOutput(chunk.rawOutput)) {
    parts.push(truncate(stringify(chunk.rawOutput), 400));
  }
  return parts.join("\n---\n");
}

function isInterestingOutput(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 0);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
