/**
 * Live per-session “working / waiting” bubble in a Telegram topic.
 * One message_id per sessionKey; progress edits in place; turn end deletes it.
 *
 * After other mid-turn outbound (telegram_send, photos, queue acks, …),
 * call bump() so the ⏳ line stays the **last** message in the topic.
 *
 * Concurrent set/bump/clear calls are serialized per session so we never spam
 * duplicate ⏳ messages (common when many tool_call events fire at once).
 */
import type { Logger } from "../env/logger";
import type { SessionStatus, TelegramPort } from "../env/types";
import type { PersistedSession } from "./persistence";

export type SendInTopic = (
  session: PersistedSession,
  text: string,
  replyMarkup?: unknown,
  opts?: {
    html?: boolean;
    alreadyHtml?: boolean;
    /**
     * True when this send *is* the working bubble (create/repost).
     * Callers that auto-bump after outbound must skip bump for these.
     */
    workingBubble?: boolean;
    notify?: boolean;
  },
) => Promise<{ message_id: number }>;

export type WorkingStatus = {
  ensure(session: PersistedSession, text?: string): Promise<void>;
  set(session: PersistedSession, text: string): Promise<void>;
  clear(session: PersistedSession): Promise<void>;
  /**
   * Delete + re-post the current bubble so it is the latest message in the
   * topic. No-op when there is no bubble (e.g. after clear / between turns).
   */
  bump(session: PersistedSession): Promise<void>;
  /** Current bubble message_id for a session, if any. */
  messageId(sessionKey: string): number | undefined;
};

export function formatWorkingStatus(
  text: string,
  status: SessionStatus = "running",
): string {
  const body = text.trim();
  if (status === "waiting-on-you") {
    return `❓ ${body || "Waiting for you…"}`;
  }
  return `⏳ ${body || "Working…"}`;
}

function shorten(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function fieldFromInput(raw: unknown, key: string): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = (raw as Record<string, unknown>)[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function isMessageNotModified(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /message is not modified|not modified/i.test(msg);
}

/**
 * Human label for the in-topic working bubble while a tool runs.
 * Prefer short action phrases so Telegram shows the agent is busy.
 */
export function formatToolWorkingLabel(
  title?: string,
  rawInput?: unknown,
): string {
  const t = (title ?? "").trim();
  const lower = t.toLowerCase();
  const desc =
    fieldFromInput(rawInput, "description") ??
    fieldFromInput(rawInput, "prompt");
  const cmd =
    fieldFromInput(rawInput, "command") ??
    fieldFromInput(rawInput, "cmd");

  // Wait/output first (titles often contain "task")
  if (
    /get_command_or_subagent_output|taskoutput|get task output/i.test(t) ||
    /waiting on|wait for task/i.test(lower)
  ) {
    return "Waiting on background tasks…";
  }
  if (
    /spawn_subagent|subagent/i.test(t) ||
    /\bTask\b/.test(t) ||
    lower.includes("research ") ||
    (lower.startsWith("research") && t.length < 80)
  ) {
    const who = desc ? shorten(desc, 55) : shorten(t, 55) || "background work";
    return `Running subagent: ${who}`;
  }
  if (/web.?search|^search\b/i.test(t)) {
    return "Searching the web…";
  }
  if (/web.?fetch|fetch:/i.test(t)) {
    const url = fieldFromInput(rawInput, "url");
    return url ? `Fetching ${shorten(url, 50)}` : "Fetching a page…";
  }
  if (/^write\b|write `/i.test(t)) {
    const path =
      fieldFromInput(rawInput, "file_path") ??
      fieldFromInput(rawInput, "path") ??
      t.replace(/^Write\s*/i, "");
    return `Writing ${shorten(path, 55)}`;
  }
  if (/ask_user|ask:/i.test(t)) {
    return "Asking you a question…";
  }
  if (/todo/i.test(t)) {
    return "Updating plan…";
  }
  if (/terminal|bash|shell|command/i.test(t) || cmd) {
    if (cmd) return `Running: ${shorten(cmd, 55)}`;
    return "Running a command…";
  }
  if (/read\b|cat |head /i.test(t)) {
    return "Reading files…";
  }
  if (t) return shorten(t, 80);
  // Prefer something from input over a useless generic
  if (desc) return shorten(desc, 70);
  if (cmd) return `Running: ${shorten(cmd, 55)}`;
  return "Working…";
}

/** Append elapsed time once a tool/wait has been running a while. */
export function formatElapsedWorking(
  label: string,
  elapsedMs: number,
): string {
  const base = label.trim() || "Working…";
  const sec = Math.floor(elapsedMs / 1000);
  if (sec < 12) return base;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const clock = m > 0 ? `${m}m ${s}s` : `${s}s`;
  // Avoid double-appending if already clocked
  if (/\(\d+m \d+s\)|\(\d+s\)$/.test(base)) {
    return base.replace(/\s*\([^)]*\)$/, ` (${clock})`);
  }
  return `${base} (${clock})`;
}

type SessionBubble = {
  messageId: number;
  /** Last text body we successfully set (with ⏳ prefix). */
  lastBody: string;
};

export function createWorkingStatus(deps: {
  telegram: TelegramPort;
  sendInTopic: SendInTopic;
  log: Logger;
}): WorkingStatus {
  const { telegram, sendInTopic, log } = deps;
  /** sessionKey → bubble state */
  const bySession = new Map<string, SessionBubble>();
  /** Serialize ensure/set/clear/bump per session to avoid duplicate posts. */
  const tail = new Map<string, Promise<void>>();

  function enqueue(sessionKey: string, op: () => Promise<void>): Promise<void> {
    const prev = tail.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(op, op);
    // Keep chain alive even if op throws
    const safe = next.catch(() => {});
    tail.set(sessionKey, safe);
    return next;
  }

  async function deleteBubbleMessage(
    session: PersistedSession,
    messageId: number,
    reason: string,
  ): Promise<void> {
    try {
      await telegram.deleteMessage({
        chatId: session.chatId,
        messageId,
      });
    } catch (err) {
      log.debug(`working status delete failed (${reason})`, {
        sessionKey: session.sessionKey,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function postBubble(
    session: PersistedSession,
    body: string,
  ): Promise<void> {
    try {
      const sent = await sendInTopic(session, body, undefined, {
        html: false,
        workingBubble: true,
      });
      bySession.set(session.sessionKey, {
        messageId: sent.message_id,
        lastBody: body,
      });
    } catch (err) {
      log.warn("working status post failed", {
        sessionKey: session.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function ensure(
    session: PersistedSession,
    text = "Working…",
  ): Promise<void> {
    return enqueue(session.sessionKey, async () => {
      const body = formatWorkingStatus(text, session.status);
      const cur = bySession.get(session.sessionKey);

      // Same text already showing — skip (prevents spam + Telegram "not modified")
      if (cur && cur.lastBody === body) return;

      if (cur) {
        try {
          await telegram.editMessageText({
            chatId: session.chatId,
            messageId: cur.messageId,
            text: body,
          });
          cur.lastBody = body;
          return;
        } catch (err) {
          if (isMessageNotModified(err)) {
            cur.lastBody = body;
            return;
          }
          // Message gone / can't edit — delete orphan if possible, then repost
          log.debug("working status edit failed; will repost once", {
            sessionKey: session.sessionKey,
            messageId: cur.messageId,
            error: err instanceof Error ? err.message : String(err),
          });
          bySession.delete(session.sessionKey);
          await deleteBubbleMessage(session, cur.messageId, "edit-failed");
        }
      }

      // Only create a new bubble if we don't have one.
      if (bySession.has(session.sessionKey)) return;

      await postBubble(session, body);
    });
  }

  async function bump(session: PersistedSession): Promise<void> {
    return enqueue(session.sessionKey, async () => {
      const cur = bySession.get(session.sessionKey);
      if (!cur) return;
      const body = cur.lastBody;
      const oldId = cur.messageId;
      bySession.delete(session.sessionKey);
      await deleteBubbleMessage(session, oldId, "bump");
      await postBubble(session, body);
    });
  }

  return {
    ensure,
    set: (session, text) => ensure(session, text),
    bump,
    async clear(session) {
      return enqueue(session.sessionKey, async () => {
        const cur = bySession.get(session.sessionKey);
        if (!cur) return;
        bySession.delete(session.sessionKey);
        await deleteBubbleMessage(session, cur.messageId, "clear");
      });
    },
    messageId(sessionKey) {
      return bySession.get(sessionKey)?.messageId;
    },
  };
}
