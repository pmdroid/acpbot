/**
 * Shared “send Telegram keyboard → wait for settle → confirm edit” shell.
 * Permission / elicitation / ask-user keep their own brokers; only this wait loop is shared.
 */
import type { Logger } from "../env/logger";
import type { SessionStatus, TelegramPort } from "../env/types";
import type { PersistedSession } from "./persistence";
import type { SendInTopic, WorkingStatus } from "./working-status";

export type InlineDecisionDeps = {
  setSessionStatus: (
    session: PersistedSession,
    status: SessionStatus,
  ) => Promise<void>;
  working: WorkingStatus;
  sendInTopic: SendInTopic;
  telegram: TelegramPort;
  log: Logger;
};

export type SettledEdit = {
  text: string;
  /** When set (e.g. "HTML"), passed to editMessageText. */
  parseMode?: string;
};

/**
 * Put the session in waiting-on-you, post a keyboard, await operator settle,
 * edit the prompt, then restore running + working bubble.
 */
export async function awaitInlineDecision<T>(
  deps: InlineDecisionDeps,
  opts: {
    session: PersistedSession;
    signal: AbortSignal;
    /** Working-bubble text while waiting (default: decision). */
    waitingBubbleText?: string;
    text: string;
    keyboard: unknown;
    sendOpts?: { html?: boolean; alreadyHtml?: boolean; notify?: boolean };
    /**
     * Register with the feature broker once the prompt message exists.
     * Call `resolve(value)` when the operator answers (usually from settle).
     */
    register: (ctx: {
      messageId: number;
      resolve: (value: T) => void;
    }) => void;
    /** Cancel pending broker state on abort (e.g. cancelAllForSession). */
    onAbort: () => void;
    /** Result when aborted or signal already fired. */
    onAbortResult: T;
    /** Body of the confirm edit after settle (keyboard cleared). */
    formatSettled: (result: T) => SettledEdit;
    /**
     * After the operator answers:
     * - `edit` (default) — replace prompt with settled text
     * - `delete` — remove the prompt message (cleaner chat for permissions)
     */
    settledAction?: "edit" | "delete";
    logContext?: Record<string, unknown>;
  },
): Promise<T> {
  const { session, signal } = opts;
  const sessionKey = session.sessionKey;

  await deps.setSessionStatus(session, "waiting-on-you");
  await deps.working.set(
    session,
    opts.waitingBubbleText ?? "Waiting for your decision…",
  );

  const sent = await deps.sendInTopic(
    session,
    opts.text,
    opts.keyboard,
    { ...opts.sendOpts, notify: true },
  );

  deps.log.info("inline decision: waiting for operator", {
    sessionKey,
    messageId: sent.message_id,
    ...opts.logContext,
  });

  const result = await new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => {
      deps.log.warn("inline decision aborted", { sessionKey });
      try {
        opts.onAbort();
      } catch {
        /* ignore */
      }
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    opts.register({
      messageId: sent.message_id,
      resolve: (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
    });
  }).catch(() => opts.onAbortResult);

  const action = opts.settledAction ?? "edit";
  if (action === "delete") {
    try {
      await deps.telegram.deleteMessage({
        chatId: session.chatId,
        messageId: sent.message_id,
      });
    } catch (err) {
      deps.log.warn("inline decision delete failed", {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    const settled = opts.formatSettled(result);
    try {
      await deps.telegram.editMessageText({
        chatId: session.chatId,
        messageId: sent.message_id,
        text: settled.text,
        ...(settled.parseMode ? { parseMode: settled.parseMode } : {}),
        replyMarkup: { inline_keyboard: [] },
      });
    } catch (err) {
      deps.log.warn("inline decision confirm edit failed", {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await deps.setSessionStatus(session, "running");
  await deps.working.set(session, "Working…");

  return result;
}
