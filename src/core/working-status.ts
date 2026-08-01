/**
 * Live per-session “working / waiting” bubble in a Telegram topic.
 * One message_id per sessionKey; MCP update edits it; turn end deletes it.
 */
import type { Logger } from "../env/logger";
import type { SessionStatus, TelegramPort } from "../env/types";
import type { PersistedSession } from "./persistence";

export type SendInTopic = (
  session: PersistedSession,
  text: string,
  replyMarkup?: unknown,
  opts?: { html?: boolean; alreadyHtml?: boolean },
) => Promise<{ message_id: number }>;

export type WorkingStatus = {
  ensure(session: PersistedSession, text?: string): Promise<void>;
  set(session: PersistedSession, text: string): Promise<void>;
  clear(session: PersistedSession): Promise<void>;
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

export function createWorkingStatus(deps: {
  telegram: TelegramPort;
  sendInTopic: SendInTopic;
  log: Logger;
}): WorkingStatus {
  const { telegram, sendInTopic, log } = deps;
  /** sessionKey → Telegram message_id */
  const bySession = new Map<string, number>();

  async function ensure(
    session: PersistedSession,
    text = "Working…",
  ): Promise<void> {
    const body = formatWorkingStatus(text, session.status);
    const existing = bySession.get(session.sessionKey);
    if (existing !== undefined) {
      try {
        await telegram.editMessageText({
          chatId: session.chatId,
          messageId: existing,
          text: body,
        });
        return;
      } catch {
        bySession.delete(session.sessionKey);
      }
    }
    try {
      const sent = await sendInTopic(session, body, undefined, {
        html: false,
      });
      bySession.set(session.sessionKey, sent.message_id);
    } catch (err) {
      log.warn("working status post failed", {
        sessionKey: session.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ensure,
    set: (session, text) => ensure(session, text),
    async clear(session) {
      const messageId = bySession.get(session.sessionKey);
      if (messageId === undefined) return;
      bySession.delete(session.sessionKey);
      try {
        await telegram.deleteMessage({
          chatId: session.chatId,
          messageId,
        });
      } catch (err) {
        log.debug("working status delete failed", {
          sessionKey: session.sessionKey,
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    messageId(sessionKey) {
      return bySession.get(sessionKey);
    },
  };
}
