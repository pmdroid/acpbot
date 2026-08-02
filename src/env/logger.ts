export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type LogMeta = Record<string, unknown>;

export type Logger = {
  level: LogLevel;
  debug(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
  child(scope: string): Logger;
};

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const SENSITIVE_KEY = /token|password|secret|authorization|api[_-]?key/i;

/** Drop/redact fields that must never hit logs. */
export function sanitizeMeta(meta?: LogMeta): LogMeta | undefined {
  if (!meta) return undefined;
  const out: LogMeta = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string" && v.length > 500) {
      out[k] = `${v.slice(0, 500)}…(+${v.length - 500})`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function parseLogLevel(
  raw: string | undefined,
  verbose?: boolean,
): LogLevel {
  if (verbose) return "debug";
  const n = (raw ?? "info").trim().toLowerCase();
  if (
    n === "debug" ||
    n === "info" ||
    n === "warn" ||
    n === "error" ||
    n === "silent"
  ) {
    return n;
  }
  return "info";
}

export type CreateLoggerOptions = {
  level?: LogLevel;
  /** Prefix for every line, e.g. "acpbot". */
  name?: string;
  /** Override sink (tests). Defaults to stderr. */
  write?: (line: string) => void;
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const name = options.name ?? "acpbot";
  const write =
    options.write ??
    ((line: string) => {
      console.error(line);
    });

  const emit = (
    lvl: Exclude<LogLevel, "silent">,
    scope: string,
    msg: string,
    meta?: LogMeta,
  ) => {
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
    const ts = new Date().toISOString();
    const clean = sanitizeMeta(meta);
    const base = `${ts} [${lvl.toUpperCase()}] ${scope} ${msg}`;
    if (clean && Object.keys(clean).length > 0) {
      write(`${base} ${JSON.stringify(clean)}`);
    } else {
      write(base);
    }
  };

  const make = (scope: string): Logger => ({
    level,
    debug: (msg, meta) => emit("debug", scope, msg, meta),
    info: (msg, meta) => emit("info", scope, msg, meta),
    warn: (msg, meta) => emit("warn", scope, msg, meta),
    error: (msg, meta) => emit("error", scope, msg, meta),
    child: (sub) => make(`${scope}:${sub}`),
  });

  return make(name);
}

export function silentLogger(): Logger {
  return createLogger({ level: "silent" });
}

/** Summarize an inbound Telegram update for logs (no full bodies by default). */
export function summarizeUpdate(update: {
  update_id: number;
  message?: {
    text?: string;
    from?: { id?: number };
    chat?: { id?: number };
    message_thread_id?: number;
  };
  edited_message?: {
    text?: string;
    from?: { id?: number };
    chat?: { id?: number };
    message_thread_id?: number;
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { chat?: { id?: number }; message_thread_id?: number };
  };
}): LogMeta {
  if (update.callback_query) {
    const cq = update.callback_query;
    return {
      kind: "callback_query",
      update_id: update.update_id,
      from: cq.from?.id,
      chat: cq.message?.chat?.id,
      thread: cq.message?.message_thread_id,
      data: cq.data,
    };
  }
  const msg = update.message ?? update.edited_message;
  if (msg) {
    const text = msg.text ?? "";
    return {
      kind: update.edited_message ? "edited_message" : "message",
      update_id: update.update_id,
      from: msg.from?.id,
      chat: msg.chat?.id,
      thread: msg.message_thread_id,
      text:
        text.length > 200 ? `${text.slice(0, 200)}…(+${text.length - 200})` : text,
    };
  }
  return { kind: "other", update_id: update.update_id };
}
