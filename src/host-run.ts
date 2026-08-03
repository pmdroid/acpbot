/**
 * ACP host process (agent stdio owner, schedules, OAuth HTTP).
 * Invoked as `acpbot host` or legacy `acpbot-host` binary name.
 */
import { applyConfigToEnv } from "./config";
import { watchConfigFile } from "./config-reload";
import { ensureAcpbotLayout, loadConfigWithSetup } from "./config-setup";
import { createLogger } from "./env/logger";
import { startAcpHostServer } from "./acp-host/server";
import { defaultAcpHostSock } from "./acp-host/protocol";
import { maybeStartOauthHttpServer } from "./acp-host/oauth-http";
import { parseReposFromEnv, scheduleTickMs } from "./acp-host/scheduler";

export async function runHostMain(): Promise<void> {
  // Create config/data/state dirs (and default config.toml if missing).
  // Host does not require bot token — worker first-run wizard fills that in.
  const layout = ensureAcpbotLayout();
  const { cfg } = await loadConfigWithSetup({
    requireTelegram: false,
    interactive: false,
    configPath: layout.configPath,
  });
  applyConfigToEnv(cfg);

  const log = createLogger({
    level: cfg.logLevel === "debug" || cfg.verbose ? "debug" : cfg.logLevel,
    name: "acp-host",
  });
  if (layout.createdConfig) {
    console.error(
      `acpbot host created config: ${layout.configPath}\n` +
        `  Run \`acpbot setup\` (or \`acpbot worker\` once) to set bot_token, then: acpbot pair approve.`,
    );
  }

  const stateDir = cfg.stateDir;
  const repos = { ...(cfg.repos ?? parseReposFromEnv(process.env)) };
  const tickMs = cfg.scheduleTickMs ?? scheduleTickMs(process.env);

  const host = await startAcpHostServer({
    stateDir,
    sockPath: defaultAcpHostSock(stateDir),
    log,
    repos,
    scheduleTickMs: tickMs,
    defaultAgent: cfg.defaultAgent ?? "grok-build",
  });
  const { sockPath, close } = host;
  // Prefer server's mutable catalog so watch + scheduler share one map
  const catalog = host.repos ?? repos;

  let configWatch: { close: () => void } | undefined;
  if (cfg.configPath) {
    configWatch = watchConfigFile({
      configPath: cfg.configPath,
      live: {
        operatorUserId: 0,
        repos: catalog,
        defaultAgent: cfg.defaultAgent,
        mcpEnabled: cfg.mcpEnabled,
      },
      reposCatalog: catalog,
      log,
    });
  }

  console.error(`acpbot host listening on ${sockPath}`);
  if (cfg.configPath) {
    console.error(`acpbot host config: ${cfg.configPath} (hot-reload on)`);
  }
  console.error(`acpbot host state dir: ${stateDir}`);
  console.error(
    "Slots keyed by sessionKey (repo/name). Worker requires this process (fail-fast at boot).",
  );
  if (Object.keys(catalog).length > 0) {
    console.error(
      `Scheduler: ${Object.keys(catalog).length} repo(s), tick ${tickMs}ms`,
    );
  } else {
    console.error(
      "Scheduler: idle — add repos with `acpbot repo` (hot-reloads, no restart)",
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
      // OAuth success writes tokens. Proxies are already attached at session
      // start (empty tools); they re-read tokens / connect without agent kill.
      // Attach-pending only matters if a remote was added but never ensured.
      const oauth = await maybeStartOauthHttpServer({
        stateDir,
        log,
        onAuthorized: async ({ id, repoKey }) => {
          const { markMcpProxyAttachPending } = await import(
            "./mcp/oauth-store"
          );
          await markMcpProxyAttachPending(stateDir, repoKey, id);
          log.info(
            "oauth authorized — token stored; live mcp-proxy will connect without agent restart",
            { id, repoKey },
          );
        },
      });
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
    console.error("acpbot host shutting down…");
    configWatch?.close();
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
