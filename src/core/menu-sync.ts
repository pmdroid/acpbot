/**
 * Push acpbot slash commands to Telegram’s “/” menu.
 * Mirrors Ursula/Kyoto: wipe default + private (lang-agnostic + en), then set.
 */

import {
  menuFingerprint,
  telegramMenuCommands,
  type TelegramMenuCommand,
} from "./commands";
import type { Logger, TelegramPort } from "../env/types";
import { silentLogger } from "../env/logger";

/** Scopes we own. Default + private only (acpbot is DM-first). */
const CLEAR_SCOPES: Array<Record<string, unknown> | undefined> = [
  undefined, // BotCommandScopeDefault
  { type: "all_private_chats" },
];

const CLEAR_LANGUAGE_CODES: Array<string | undefined> = [undefined, "en"];

let lastFingerprint: string | null = null;
let syncChain: Promise<unknown> = Promise.resolve();

export function resetMenuSyncStateForTests(): void {
  lastFingerprint = null;
  syncChain = Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type SyncMenuOptions = {
  force?: boolean;
  log?: Logger;
  /** Inject menu list (tests). Default: telegramMenuCommands(). */
  commands?: TelegramMenuCommand[];
};

/**
 * Clear stale menus then register the short command list.
 * Concurrent callers are serialized; unchanged menus skip the network wipe.
 */
export async function syncTelegramSlashMenu(
  telegram: TelegramPort,
  opts: SyncMenuOptions = {},
): Promise<TelegramMenuCommand[]> {
  const run = async (): Promise<TelegramMenuCommand[]> => {
    const log = (opts.log ?? silentLogger()).child("menu");
    const commands = opts.commands ?? telegramMenuCommands();
    const fp = menuFingerprint(commands);

    if (!opts.force && lastFingerprint === fp) {
      log.info("slash menu unchanged — skip setMyCommands", {
        count: commands.length,
      });
      return commands;
    }

    const shouldClear =
      opts.force || commands.length === 0 || lastFingerprint === null;

    if (shouldClear && telegram.deleteMyCommands) {
      for (const scope of CLEAR_SCOPES) {
        for (const languageCode of CLEAR_LANGUAGE_CODES) {
          try {
            await telegram.deleteMyCommands({
              ...(scope ? { scope } : {}),
              ...(languageCode ? { languageCode } : {}),
            });
          } catch (err) {
            log.warn("deleteMyCommands failed", {
              scope: scope ?? "default",
              languageCode: languageCode ?? "(none)",
              error: err instanceof Error ? err.message : String(err),
            });
          }
          await sleep(40);
        }
      }
    }

    if (commands.length === 0) {
      log.warn("no slash commands to register");
      lastFingerprint = fp;
      return commands;
    }

    if (!telegram.setMyCommands) {
      log.warn("telegram port has no setMyCommands — menu not synced");
      return commands;
    }

    log.info("registering slash menu", {
      commands: commands.map((c) => `/${c.command}`).join(" "),
      count: commands.length,
    });

    const targets: Array<{
      scope?: Record<string, unknown>;
      languageCode?: string;
    }> = [
      {},
      { languageCode: "en" },
      { scope: { type: "all_private_chats" } },
      { scope: { type: "all_private_chats" }, languageCode: "en" },
    ];

    for (const t of targets) {
      try {
        await telegram.setMyCommands({
          commands,
          ...(t.scope ? { scope: t.scope } : {}),
          ...(t.languageCode ? { languageCode: t.languageCode } : {}),
        });
      } catch (err) {
        log.warn("setMyCommands failed", {
          scope: t.scope ?? "default",
          languageCode: t.languageCode ?? "(none)",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      await sleep(40);
    }

    if (telegram.getMyCommands) {
      try {
        const live = await telegram.getMyCommands({});
        log.info("slash menu live", {
          count: live.length,
          commands: live.map((c) => `/${c.command}`).join(" "),
        });
      } catch {
        /* best effort */
      }
    }

    lastFingerprint = fp;
    return commands;
  };

  const done = syncChain.then(run, run);
  syncChain = done.then(
    () => undefined,
    () => undefined,
  );
  return done;
}
