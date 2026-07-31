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
 */
import { createLogger } from "../env/logger";
import { startAcpHostServer } from "./server";
import { defaultAcpHostSock } from "./protocol";
import { maybeStartOauthHttpServer } from "./oauth-http";

async function main(): Promise<void> {
  const log = createLogger({
    level: process.env.TACP_LOG_LEVEL === "debug" ? "debug" : "info",
    name: "acp-host",
  });
  const stateDir =
    process.env.TACP_ACPX_STATE_DIR?.trim() || "./data/acpx-state";
  const { sockPath, close } = await startAcpHostServer({
    stateDir,
    sockPath: defaultAcpHostSock(stateDir),
    log,
  });
  console.error(`tacp acp-host listening on ${sockPath}`);
  console.error(
    "Slots keyed by sessionKey (repo/name). Worker: TACP_ACP_HOST=1",
  );

  let oauthClose: (() => Promise<void>) | undefined;
  try {
    const oauth = await maybeStartOauthHttpServer({ stateDir, log });
    if (oauth) {
      oauthClose = oauth.close;
      console.error(
        `tacp oauth callback listening on ${oauth.url} (TACP_OAUTH_CALLBACK_BASE → /oauth/callback)`,
      );
    }
  } catch (err) {
    console.error(
      `tacp oauth http failed to start: ${err instanceof Error ? err.message : err}`,
    );
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
