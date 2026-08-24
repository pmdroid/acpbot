/**
 * Private-chat topics (BotFather: Threaded Mode).
 *
 * Telegram's getMe.has_topics_enabled flag is what acpbot sessions need.
 * BotFather's mini-app labels the same toggle Threaded Mode.
 */
import { realTelegram, type RealTelegramOptions } from "./real-telegram";
import type { BotMe } from "./types";

export class TopicsDisabledError extends Error {
  constructor() {
    super(
      "Bot does not have topics enabled (getMe.has_topics_enabled is false). " +
        "In @BotFather, open this bot → Bot Settings → turn on Threaded Mode " +
        "(also listed as topics in private chats). Then re-run acpbot setup " +
        "or restart acpbot worker.",
    );
    this.name = "TopicsDisabledError";
  }
}

export function assertBotMeHasTopics(me: BotMe): void {
  if (!me.has_topics_enabled) {
    throw new TopicsDisabledError();
  }
}

export type VerifyBotTokenTopicsOptions = Pick<
  RealTelegramOptions,
  "token" | "apiBase" | "fetchImpl"
>;

/** getMe + require has_topics_enabled. Used by setup (fail closed) and worker boot. */
export async function verifyBotTokenTopics(
  options: VerifyBotTokenTopicsOptions,
): Promise<BotMe> {
  const telegram = realTelegram({
    token: options.token,
    apiBase: options.apiBase,
    fetchImpl: options.fetchImpl,
  });
  const me = await telegram.getMe();
  assertBotMeHasTopics(me);
  return me;
}

export type BotTokenVerifier = (token: string) => Promise<BotMe>;
