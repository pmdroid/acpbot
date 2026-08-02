#!/usr/bin/env bun
import {
  AcpHostRequiredError,
  assertAcpHostReady,
} from "./acp-host/client";
import { applyConfigToEnv } from "./config";
import {
  isSetupCliCommand,
  loadConfigWithSetup,
  runSetupCommand,
} from "./config-setup";
import { createDaemon, TopicsDisabledError } from "./core/daemon";
import { cleanupLegacyOutboundQueues } from "./core/legacy-cleanup";
import { systemClock } from "./env/clock";
import { createLogger } from "./env/logger";
import { realAgents } from "./env/real-agents";
import { realTelegram } from "./env/real-telegram";
import { speechFromConfig } from "./env/speech";
import { createJsonFileStore } from "./env/store";
import type { Environment } from "./env/types";
import {
  isServiceCliCommand,
  runServiceCli,
  serviceCliHelp,
} from "./setup/service-cli";
import {
  isPairCliCommand,
  pairCliHelp,
  runPairCli,
} from "./setup/pair-cli";
import { loadPairedOperator } from "./core/pairing";

async function main(): Promise<void> {
  // Service control: install | start | stop | restart | status | uninstall
  if (isServiceCliCommand(process.argv)) {
    const code = await runServiceCli(process.argv);
    process.exitCode = code;
    return;
  }

  // Pairing: list / approve Telegram operator codes (no host required)
  if (isPairCliCommand(process.argv)) {
    const code = await runPairCli(process.argv);
    process.exitCode = code;
    return;
  }

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.error(`acpbot — Telegram worker for ACP agents

  acpbot              Run worker (foreground)
  acpbot setup        Guided setup TUI
  acpbot pair list|approve <code>|status
  acpbot install      Install host + worker as background services
  acpbot start|stop|restart|status|uninstall

${pairCliHelp()}

${serviceCliHelp()}`);
    return;
  }

  // Explicit onboarding TUI: `acpbot setup` | `acpbot init` | `acpbot --setup`
  if (isSetupCliCommand(process.argv)) {
    await runSetupCommand();
    return;
  }

  const { cfg, layout } = await loadConfigWithSetup({ requireTelegram: true });
  // loadConfig already resolves stateDir to absolute.
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
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  // Drop pre-worker-API disk queues (no longer drained).
  const legacy = await cleanupLegacyOutboundQueues(stateDirAbs, { log });
  if (legacy.removed.length > 0) {
    console.error(
      `acpbot cleanup: removed legacy queue dir(s): ${legacy.removed.join(", ")}`,
    );
  }

  const store = await createJsonFileStore(cfg.storePath);

  const acpbotConfig: import("./env/types").AcpbotConfig = {
    operatorUserId: cfg.operatorUserId,
    ...(cfg.operatorChatId !== undefined
      ? { operatorChatId: cfg.operatorChatId }
      : {}),
    ...(cfg.repos ? { repos: cfg.repos } : {}),
    ...(cfg.defaultAgent ? { defaultAgent: cfg.defaultAgent } : {}),
    ...(cfg.skillRoots ? { skillRoots: cfg.skillRoots } : {}),
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

  const env: Environment = {
    config: acpbotConfig,
    telegram: realTelegram({ token: cfg.botToken, log }),
    agents,
    clock: systemClock(),
    store,
    log,
    speech,
  };

  // Skills: install once with `bun run skills:install` (not on every boot).

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

  const stop = () => {
    log.info("signal: shutting down");
    ac.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    console.error(
      `acpbot starting (agent: ${cfg.defaultAgent}, log: ${cfg.logLevel}, acp-host)…`,
    );
    if (cfg.configPath) console.error(`acpbot config: ${cfg.configPath}`);
    console.error(`acpbot state dir: ${stateDirAbs}`);
    console.error(`acpbot store: ${cfg.storePath}`);
    if (cfg.oauthCallbackBase?.trim()) {
      console.error(
        `acpbot oauth: worker shares state with acp-host at ${stateDirAbs}/mcp-oauth ` +
          `(same config.toml / state_dir for host + worker)`,
      );
    }
    await daemon.run(ac.signal);
    console.error("acpbot stopped.");
  } catch (err) {
    if (err instanceof TopicsDisabledError) {
      log.error(err.message);
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
