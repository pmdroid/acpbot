#!/usr/bin/env bun
/**
 * Long-lived ACP host — owns agent stdio processes (any agent command).
 *
 *   Terminal 1: bun run acp-host
 *   Terminal 2: TACP_ACP_HOST=1 bun run start
 *
 * Worker restart detaches; agent processes stay. Next ensure reattaches.
 * Also scans TACP_REPOS_JSON repos' `.tacp/schedules/` and fires due jobs
 * into the right session slots (even if the Telegram worker is down).
 */
import { createLogger } from "../env/logger";
import { startAcpHostServer } from "./server";
import { defaultAcpHostSock } from "./protocol";
import { parseReposFromEnv, scheduleTickMs } from "./scheduler";

async function main(): Promise<void> {
  const log = createLogger({
    level: process.env.TACP_LOG_LEVEL === "debug" ? "debug" : "info",
    name: "acp-host",
  });
  const stateDir =
    process.env.TACP_ACPX_STATE_DIR?.trim() || "./data/acpx-state";
  const repos = parseReposFromEnv(process.env);
  const tickMs = scheduleTickMs(process.env);
  const { sockPath, close } = await startAcpHostServer({
    stateDir,
    sockPath: defaultAcpHostSock(stateDir),
    log,
    repos,
    scheduleTickMs: tickMs,
    defaultAgent: process.env.TACP_DEFAULT_AGENT?.trim() || "grok-build",
  });
  console.error(`tacp acp-host listening on ${sockPath}`);
  console.error(
    "Slots keyed by sessionKey (repo/name). Worker: TACP_ACP_HOST=1",
  );
  if (Object.keys(repos).length > 0) {
    console.error(
      `Scheduler: ${Object.keys(repos).length} repo(s), tick ${tickMs}ms (TACP_SCHEDULE_TICK_MS)`,
    );
  } else {
    console.error(
      "Scheduler: idle — set TACP_REPOS_JSON to scan .tacp/schedules/",
    );
  }

  const shutdown = async () => {
    console.error("tacp acp-host shutting down…");
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
