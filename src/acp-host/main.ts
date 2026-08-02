#!/usr/bin/env bun
/**
 * Long-lived ACP host — owns agent stdio processes (any agent command).
 *
 *   acpbot-host                 # reads ~/.config/acpbot/config.toml
 *   acpbot-host --config PATH
 *
 * Worker restart detaches; agent processes stay. Next ensure reattaches.
 * Scans [repos] for schedules under each repo’s `.acpbot/schedules/` (legacy `.tacp/`).
 * When oauth.callback_base is set, also listens for GET /oauth/callback.
 *
 * Worker and acp-host must share the same state_dir from config.
 */
import { applyConfigToEnv, loadConfig } from "../config";
import { createLogger } from "../env/logger";
import { startAcpHostServer } from "./server";
import { defaultAcpHostSock } from "./protocol";
import { maybeStartOauthHttpServer } from "./oauth-http";
import { parseReposFromEnv, scheduleTickMs } from "./scheduler";

async function main(): Promise<void> {
  const cfg = loadConfig({ requireTelegram: false });
  applyConfigToEnv(cfg);

  const log = createLogger({
    level: cfg.logLevel === "debug" || cfg.verbose ? "debug" : cfg.logLevel,
    name: "acp-host",
  });

  const stateDir = cfg.stateDir;
  const repos = cfg.repos ?? parseReposFromEnv(process.env);
  const tickMs = cfg.scheduleTickMs ?? scheduleTickMs(process.env);

  const { sockPath, close } = await startAcpHostServer({
    stateDir,
    sockPath: defaultAcpHostSock(stateDir),
    log,
    repos,
    scheduleTickMs: tickMs,
    defaultAgent: cfg.defaultAgent ?? "grok-build",
  });
  console.error(`acpbot acp-host listening on ${sockPath}`);
  if (cfg.configPath) console.error(`acpbot acp-host config: ${cfg.configPath}`);
  console.error(`acpbot acp-host state dir: ${stateDir}`);
  console.error(
    "Slots keyed by sessionKey (repo/name). Worker requires this process (fail-fast at boot).",
  );
  if (Object.keys(repos).length > 0) {
    console.error(
      `Scheduler: ${Object.keys(repos).length} repo(s), tick ${tickMs}ms`,
    );
  } else {
    console.error(
      "Scheduler: idle — add [repos] in config.toml to scan schedules",
    );
  }

  let oauthClose: (() => Promise<void>) | undefined;
  const oauthBase = cfg.oauthCallbackBase?.trim();
  if (oauthBase) {
    console.error(
      `acpbot oauth: callback base ${oauthBase} → state ${stateDir}/mcp-oauth ` +
        `(worker must use the same state_dir)`,
    );
    try {
      const oauth = await maybeStartOauthHttpServer({ stateDir, log });
      if (oauth) {
        oauthClose = oauth.close;
        console.error(
          `acpbot oauth callback listening on ${oauth.url} ` +
            `(GET /oauth/callback; bind ${oauth.host}:${oauth.port})`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `acpbot oauth http FAILED to start: ${msg}\n` +
          `  oauth.callback_base is set but the callback listener could not bind.\n` +
          `  Primary /mcp auth redirect will not complete. Options:\n` +
          `  - free the port / set oauth.listen_port in config.toml\n` +
          `  - use paste fallback: /mcp code <full-callback-url>\n` +
          `  - remove oauth.callback_base if OAuth is not needed`,
      );
      await close().catch(() => {});
      process.exit(1);
    }
  }

  const shutdown = async () => {
    console.error("acpbot acp-host shutting down…");
    if (oauthClose) {
      try {
        await oauthClose();
      } catch {
        /* */
      }
    }
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
