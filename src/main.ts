#!/usr/bin/env bun
import {
  AcpHostRequiredError,
  assertAcpHostReady,
} from "./acp-host/client";
import { applyConfigToEnv, loadConfig } from "./config";
import { createDaemon, TopicsDisabledError } from "./core/daemon";
import { cleanupLegacyOutboundQueues } from "./core/legacy-cleanup";
import { systemClock } from "./env/clock";
import { createLogger } from "./env/logger";
import { realAgents } from "./env/real-agents";
import { realTelegram } from "./env/real-telegram";
import { speechFromConfig } from "./env/speech";
import { createJsonFileStore } from "./env/store";
import type { Environment } from "./env/types";

async function main(): Promise<void> {
  const cfg = loadConfig({ requireTelegram: true });
  applyConfigToEnv(cfg);
  // loadConfig already resolves stateDir to absolute.
  const stateDirAbs = cfg.stateDir;
  const log = createLogger({ level: cfg.logLevel, name: "acpbot" });

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

  const tacpConfig: import("./env/types").TacpConfig = {
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
  };

  const speech = speechFromConfig(cfg.speech, process.env, log);

  log.info("boot", {
    defaultAgent: cfg.defaultAgent,
    logLevel: cfg.logLevel,
    operatorUserId: cfg.operatorUserId,
    repos: Object.keys(cfg.repos ?? {}),
    ttsMode: cfg.ttsMode,
    mcpEnabled: cfg.mcpEnabled !== false,
    speech: {
      ttsProvider: cfg.speech?.ttsProvider ?? "auto",
      sttProvider: cfg.speech?.sttProvider ?? "auto",
      stt: Boolean(speech?.stt),
      tts: Boolean(speech?.tts),
    },
  });

  const agents = realAgents({
    config: tacpConfig,
    stateDir: stateDirAbs,
    verbose: cfg.verbose,
    log,
  });

  const env: Environment = {
    config: tacpConfig,
    telegram: realTelegram({ token: cfg.botToken, log }),
    agents,
    clock: systemClock(),
    store,
    log,
    speech,
  };

  // Skills: install once with `bun run skills:install` (not on every boot).

  const daemon = createDaemon(env, { stateDir: stateDirAbs });
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
