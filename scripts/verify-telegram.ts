// Run with the Telegram worker stopped; this uses the real paired account,
// agent host, durable topic store, and outbound API. Never logs credentials.
import { loadConfig, applyConfigToEnv } from "../src/config";
import { loadPairedOperator } from "../src/core/pairing";
import { createDaemon } from "../src/core/daemon";
import { realAgents } from "../src/env/real-agents";
import { realTelegram } from "../src/env/real-telegram";
import { createJsonFileStore } from "../src/env/store";
import { systemClock } from "../src/env/clock";
import { silentLogger } from "../src/env/logger";
import { workerApiRequest, workerApiSockPath } from "../src/mcp/worker-api";

const cfg = loadConfig();
applyConfigToEnv(cfg);
const paired = await loadPairedOperator(cfg.stateDir);
if (!paired?.chatId) throw new Error("Pair operator before checking delivery");
const config = {
  operatorUserId: paired.userId, operatorChatId: paired.chatId,
  repos: cfg.repos, defaultAgent: cfg.defaultAgent,
  mcpEnabled: true, permissionMode: "ask" as const,
};
const log = silentLogger();
const daemon = createDaemon({
  config, log, clock: systemClock(),
  telegram: realTelegram({ token: cfg.botToken, log }),
  agents: realAgents({ config, stateDir: cfg.stateDir, log }),
  store: await createJsonFileStore(cfg.storePath),
}, { stateDir: cfg.stateDir });
const abort = new AbortController();
const deadline = setTimeout(() => { abort.abort(); process.exit(1); }, 180_000);
const running = daemon.run(abort.signal);
try {
  const socket = workerApiSockPath(cfg.stateDir);
  for (let i = 0; i < 100; i++) {
    if ((await workerApiRequest("/v1/health", undefined, { sockPath: socket, method: "GET", timeoutMs: 100 })).ok) break;
    await Bun.sleep(100);
  }
  for (const agent of ["mimo", "codex"]) {
    const session = await daemon.createSession({ repo: "playground", name: `${agent}-ready`, agent });
    console.log(agent, "topic created", session.messageThreadId);
    const sent = await workerApiRequest("/v1/telegram/message", {
      sessionKey: session.sessionKey, kind: "message",
      text: `Setup check: ${agent} is connected. You can continue work by writing in this topic.`,
    }, { sockPath: socket });
    if (!sent.ok) throw new Error(JSON.stringify(sent));
    await daemon.handleUpdate({ update_id: -1, message: {
      message_id: 0, date: Math.floor(Date.now()/1000),
      from: { id: paired.userId, first_name: "Operator" },
      chat: { id: paired.chatId, type: "private" },
      message_thread_id: session.messageThreadId, is_topic_message: true,
      text: `Reply exactly ${agent.toUpperCase()}_BRIDGE_OK. Do not use tools or change files.`,
    } });
    for (let i = 0; i < 120; i++) {
      const current = (await daemon.listSessions()).find(s => s.sessionKey === session.sessionKey);
      if (current?.status === "failed") throw new Error(`${agent} turn failed`);
      if (current?.status === "done") break;
      if (i === 119) throw new Error(`${agent} turn did not finish`);
      await Bun.sleep(1000);
    }
    console.log(agent, "turn completed through daemon");
    if (agent === "mimo") {
      for (const [route, path] of [
        ["photo", "/data/projects/playground/output/telegram-bridge-check.png"],
        ["document", "/data/projects/playground/output/telegram-bridge-check.txt"],
      ]) {
        const result = await workerApiRequest(`/v1/telegram/${route}`, {
          sessionKey: session.sessionKey, path, caption: "Bridge attachment delivery check",
        }, { sockPath: socket });
        console.log(route, JSON.stringify(result));
        if (!result.ok) throw new Error(`Delivery failed: ${route}`);
      }
    }
  }
} finally {
  clearTimeout(deadline);
  abort.abort();
  await running;
}
// ACP host connections intentionally outlive worker turns. This diagnostic
// client exits after delivery while the systemd host retains the sessions.
process.exit(0);
