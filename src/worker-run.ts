/**
 * Telegram worker process.
 * Invoked as `acpbot worker` (foreground).
 */
import {
  AcpHostRequiredError,
  assertAcpHostReady,
} from "./acp-host/client";
import { applyConfigToEnv } from "./config";
import { watchConfigFile } from "./config-reload";
import { loadConfigWithSetup } from "./config-setup";
import { createDaemon, TopicsDisabledError } from "./core/daemon";
import { cleanupLegacyOutboundQueues } from "./core/legacy-cleanup";
import { loadPairedOperator } from "./core/pairing";
import { systemClock } from "./env/clock";
import { createLogger } from "./env/logger";
import { realAgents } from "./env/real-agents";
import { realTelegram } from "./env/real-telegram";
import { telegramBotApiBase } from "./env/env-keys";
import { speechFromConfig } from "./env/speech";
import { createJsonFileStore } from "./env/store";
import type { Environment } from "./env/types";

export async function runWorkerMain(): Promise<void> {
  let loaded: Awaited<ReturnType<typeof loadConfigWithSetup>>;
  try {
    loaded = await loadConfigWithSetup({ requireTelegram: true });
  } catch (err) {
    if (err instanceof TopicsDisabledError) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  const { cfg, layout } = loaded;
  const stateDirAbs = cfg.stateDir;
  const paired = await loadPairedOperator(stateDirAbs);
  if (paired) {
    cfg.operatorUserId = paired.userId;
    if (paired.chatId !== undefined && cfg.operatorChatId === undefined) {
      cfg.operatorChatId = paired.chatId;
    }
  }
  applyConfigToEnv(cfg);
  const log = createLogger({ level: cfg.logLevel, name: "acpbot" });
  if (layout.createdConfig) {
    console.error(`acpbot created config: ${layout.configPath}`);
  }

  // acp-host is mandatory — fail before Telegram / agents wire-up.
  try {
    const host = await assertAcpHostReady({ stateDir: stateDirAbs });
    log.info("acp-host ready", { sockPath: host.sockPath });
    console.error(`acpbot acp-host: ok (${host.sockPath})`);
  } catch (err) {
    if (err instanceof AcpHostRequiredError) {
      log.error(err.message);
      console.error(err.message);
      console.error("Start the host first:  acpbot host");
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const legacy = await cleanupLegacyOutboundQueues(stateDirAbs, { log });
  if (legacy.removed.length > 0) {
    console.error(
      `acpbot cleanup: removed legacy queue dir(s): ${legacy.removed.join(", ")}`,
    );
  }

  const store = await createJsonFileStore(cfg.storePath);

  // Mutable bag — config watch updates in place for hot reload (e.g. new repos).
  const acpbotConfig: import("./env/types").AcpbotConfig = {
    operatorUserId: cfg.operatorUserId,
    ...(cfg.operatorChatId !== undefined
      ? { operatorChatId: cfg.operatorChatId }
      : {}),
    repos: { ...(cfg.repos ?? {}) },
    ...(cfg.hostsCatalog ? { hostsCatalog: cfg.hostsCatalog } : {}),
    ...(cfg.defaultAgent ? { defaultAgent: cfg.defaultAgent } : {}),
    ...(cfg.skillRoots ? { skillRoots: [...cfg.skillRoots] } : {}),
    ...(cfg.acpMediaAttachments !== undefined
      ? { acpMediaAttachments: cfg.acpMediaAttachments }
      : {}),
    ...(cfg.ttsMode ? { ttsMode: cfg.ttsMode } : {}),
    ...(cfg.mcpEnabled !== undefined ? { mcpEnabled: cfg.mcpEnabled } : {}),
    ...(cfg.permissionMode ? { permissionMode: cfg.permissionMode } : {}),
  };

  const speech = speechFromConfig(cfg.speech, process.env, log);

  log.info("boot", {
    defaultAgent: cfg.defaultAgent,
    logLevel: cfg.logLevel,
    operatorUserId: cfg.operatorUserId,
    repos: Object.keys(cfg.repos ?? {}),
    ttsMode: cfg.ttsMode,
    mcpEnabled: cfg.mcpEnabled !== false,
    permissionMode: cfg.permissionMode ?? "ask",
    speech: {
      ttsProvider: cfg.speech?.ttsProvider ?? "auto",
      sttProvider: cfg.speech?.sttProvider ?? "auto",
      stt: Boolean(speech?.stt),
      tts: Boolean(speech?.tts),
    },
  });

  const agents = realAgents({
    config: acpbotConfig,
    stateDir: stateDirAbs,
    verbose: cfg.verbose,
    log,
  });

  const telegramApiBase = telegramBotApiBase(cfg.botToken);
  const env: Environment = {
    config: acpbotConfig,
    telegram: realTelegram({
      token: cfg.botToken,
      log,
      ...(telegramApiBase ? { apiBase: telegramApiBase } : {}),
    }),
    agents,
    clock: systemClock(),
    store,
    log,
    speech,
  };

  const daemon = createDaemon(env, {
    stateDir: stateDirAbs,
    ...(cfg.configPath ? { configPath: cfg.configPath } : {}),
  });
  if (cfg.operatorUserId <= 0) {
    console.error(
      "acpbot: not paired — DM the bot for a code, then: acpbot pair approve <code>",
    );
  }
  const ac = new AbortController();

  let configWatch: { close: () => void } | undefined;
  if (cfg.configPath) {
    configWatch = watchConfigFile({
      configPath: cfg.configPath,
      live: acpbotConfig,
      log,
    });
  }

  const stop = () => {
    log.info("signal: shutting down");
    configWatch?.close();
    ac.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    console.error(
      `acpbot worker starting (agent: ${cfg.defaultAgent}, log: ${cfg.logLevel})…`,
    );
    if (cfg.configPath) {
      console.error(`acpbot config: ${cfg.configPath} (hot-reload on)`);
    }
    console.error(`acpbot state dir: ${stateDirAbs}`);
    console.error(`acpbot store: ${cfg.storePath}`);
    if (cfg.oauthCallbackBase?.trim()) {
      console.error(
        `acpbot oauth: worker shares state with host at ${stateDirAbs}/mcp-oauth ` +
          `(same config.toml / state_dir for host + worker)`,
      );
    }
    await daemon.run(ac.signal);
    console.error("acpbot worker stopped.");
  } catch (err) {
    if (err instanceof TopicsDisabledError) {
      log.error(err.message);
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  } finally {
    configWatch?.close();
  }
}
