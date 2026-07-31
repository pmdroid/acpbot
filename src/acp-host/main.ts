#!/usr/bin/env bun
/**
 * Long-lived ACP host — owns agent stdio processes (any agent command).
 *
 *   Terminal 1: bun run acp-host
 *   Terminal 2: TACP_ACP_HOST=1 bun run start
 *
 * Worker restart detaches; agent processes stay. Next ensure reattaches.
 *
 * When TACP_OAUTH_CALLBACK_BASE is set, also listens for GET /oauth/callback
 * so remote MCP OAuth can complete without paste-code as the primary UX.
 *
 * Worker and acp-host **must** use the same absolute TACP_ACPX_STATE_DIR
 * (pending PKCE is written by the worker; callback + ensure run on the host).
 */
import { createLogger } from "../env/logger";
import { startAcpHostServer } from "./server";
import { defaultAcpHostSock } from "./protocol";
import { maybeStartOauthHttpServer } from "./oauth-http";
import { resolveOAuthStateDir } from "../mcp/oauth-store";

async function main(): Promise<void> {
  const log = createLogger({
    level: process.env.TACP_LOG_LEVEL === "debug" ? "debug" : "info",
    name: "acp-host",
  });
  // Absolute — matches worker after loadConfig / createDaemon resolve.
  const stateDir = resolveOAuthStateDir(
    process.env.TACP_ACPX_STATE_DIR?.trim() || "./data/acpx-state",
  );
  // Keep process.env in sync so nested helpers see the same absolute path.
  process.env.TACP_ACPX_STATE_DIR = stateDir;

  const { sockPath, close } = await startAcpHostServer({
    stateDir,
    sockPath: defaultAcpHostSock(stateDir),
    log,
  });
  console.error(`tacp acp-host listening on ${sockPath}`);
  console.error(`tacp acp-host state dir: ${stateDir}`);
  console.error(
    "Slots keyed by sessionKey (repo/name). Worker: TACP_ACP_HOST=1",
  );

  let oauthClose: (() => Promise<void>) | undefined;
  const oauthBase = process.env.TACP_OAUTH_CALLBACK_BASE?.trim();
  if (oauthBase) {
    console.error(
      `tacp oauth: callback base ${oauthBase} → state ${stateDir}/mcp-oauth ` +
        `(worker must use the same absolute TACP_ACPX_STATE_DIR)`,
    );
    try {
      const oauth = await maybeStartOauthHttpServer({ stateDir, log });
      if (oauth) {
        oauthClose = oauth.close;
        console.error(
          `tacp oauth callback listening on ${oauth.url} ` +
            `(GET /oauth/callback; bind ${oauth.host}:${oauth.port})`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `tacp oauth http FAILED to start: ${msg}\n` +
          `  TACP_OAUTH_CALLBACK_BASE is set but the callback listener could not bind.\n` +
          `  Primary /mcp auth redirect will not complete. Options:\n` +
          `  - free the port / set TACP_OAUTH_LISTEN_PORT / fix permissions\n` +
          `  - use paste fallback: /mcp code <full-callback-url>\n` +
          `  - unset TACP_OAUTH_CALLBACK_BASE if OAuth is not needed`,
      );
      // Fail closed on boot when OAuth was explicitly configured.
      await close().catch(() => {});
      process.exit(1);
    }
  }

  const shutdown = async () => {
    console.error("tacp acp-host shutting down…");
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
