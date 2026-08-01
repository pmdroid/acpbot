#!/usr/bin/env bun
import {
  AcpHostRequiredError,
  assertAcpHostReady,
} from "./acp-host/client";
import { loadConfig } from "./config";
import { createDaemon, TopicsDisabledError } from "./core/daemon";
import { systemClock } from "./env/clock";
import { createLogger } from "./env/logger";
import { realAgents } from "./env/real-agents";
import { realTelegram } from "./env/real-telegram";
import { speechFromEnv } from "./env/speech";
import { createJsonFileStore } from "./env/store";
import type { Environment } from "./env/types";

async function main(): Promise<void> {
  const cfg = loadConfig();
  // loadConfig already resolves acpxStateDir to absolute.
  const acpxStateDirAbs = cfg.acpxStateDir;
  const log = createLogger({ level: cfg.logLevel, name: "tacp" });

  // acp-host is mandatory — fail before Telegram / agents wire-up.
  try {
    const host = await assertAcpHostReady({ stateDir: acpxStateDirAbs });
    log.info("acp-host ready", { sockPath: host.sockPath });
    console.error(`tacp acp-host: ok (${host.sockPath})`);
  } catch (err) {
    if (err instanceof AcpHostRequiredError) {
      log.error(err.message);
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
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

  const speech = speechFromEnv(process.env, log);

  log.info("boot", {
    defaultAgent: cfg.defaultAgent,
    logLevel: cfg.logLevel,
    operatorUserId: cfg.operatorUserId,
    repos: Object.keys(cfg.repos ?? {}),
    ttsMode: cfg.ttsMode,
    mcpEnabled: cfg.mcpEnabled !== false,
    speech: {
      stt: Boolean(speech?.stt),
      tts: Boolean(speech?.tts),
    },
  });

  const agents = realAgents({
    config: tacpConfig,
    acpxStateDir: acpxStateDirAbs,
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

  const daemon = createDaemon(env, { acpxStateDir: acpxStateDirAbs });
  const ac = new AbortController();

  const stop = () => {
    log.info("signal: shutting down");
    ac.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    console.error(
      `tacp starting (agent: ${cfg.defaultAgent}, log: ${cfg.logLevel}, acp-host)…`,
    );
    console.error(`tacp state dir: ${acpxStateDirAbs}`);
    if (process.env.TACP_OAUTH_CALLBACK_BASE?.trim()) {
      console.error(
        `tacp oauth: worker shares state with acp-host at ${acpxStateDirAbs}/mcp-oauth ` +
          `(set the same absolute TACP_ACPX_STATE_DIR on both processes)`,
      );
    }
    await daemon.run(ac.signal);
    console.error("tacp stopped.");
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
