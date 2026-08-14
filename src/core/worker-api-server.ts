/**
 * Worker outbound API — HTTP over Unix socket.
 * MCP tools POST here; the daemon resolves sessionKey → Telegram topic.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import { workerApiSockPath } from "../mcp/worker-api";

export type WorkerApiHandlers = {
  sendMessage(input: {
    sessionKey: string;
    text: string;
    kind: "update" | "message";
  }): Promise<{ message?: string }>;
  sendPhoto(input: {
    sessionKey: string;
    path: string;
    caption?: string;
    filename?: string;
  }): Promise<{ message?: string; bytes?: number }>;
  sendDocument(input: {
    sessionKey: string;
    path: string;
    caption?: string;
    filename?: string;
  }): Promise<{ message?: string; bytes?: number }>;
  speak(input: {
    sessionKey: string;
    text: string;
  }): Promise<{ message?: string; bytes?: number }>;
  /** Multi-agent spawn (optional — when unset, routes return 501). */
  agentSpawn?(input: {
    sessionKey: string;
    name: string;
    agent?: string;
    role?: string;
    prompt?: string;
    headless?: boolean;
  }): Promise<{ message?: string; record?: unknown }>;
  agentList?(input: {
    sessionKey: string;
  }): Promise<{ message?: string; children?: unknown[] }>;
  agentKill?(input: {
    sessionKey: string;
    childSessionKey?: string;
    id?: string;
    dispose?: boolean;
    removeWorktree?: boolean;
  }): Promise<{ message?: string }>;
  agentSend?(input: {
    sessionKey: string;
    to: string;
    message: string;
    mode?: "prompt" | "steer";
  }): Promise<{ message?: string; to?: string; summary?: string }>;
  agentWait?(input: {
    sessionKey: string;
    childSessionKey?: string;
    id?: string;
    to?: string;
    timeout_sec?: number;
    poll_sec?: number;
  }): Promise<{
    message?: string;
    status?: string;
    summary?: string;
    sessionKey?: string;
  }>;
  /** EVE background directives (optional). */
  eveRun?(input: {
    sessionKey: string;
    name?: string;
    path?: string;
    source?: string;
    args?: unknown;
    skip_approval?: boolean;
    agents_max?: number;
  }): Promise<{ message?: string; run?: unknown; runId?: string }>;
  eveApprove?(input: {
    sessionKey: string;
    runId: string;
  }): Promise<{ message?: string; run?: unknown }>;
  eveStatus?(input: {
    sessionKey: string;
    runId: string;
  }): Promise<{ message?: string; run?: unknown; text?: string }>;
  eveList?(input: {
    sessionKey: string;
  }): Promise<{
    message?: string;
    runs?: unknown[];
    scripts?: unknown[];
  }>;
  evePause?(input: {
    sessionKey: string;
    runId: string;
  }): Promise<{ message?: string; run?: unknown }>;
  eveResume?(input: {
    sessionKey: string;
    runId: string;
  }): Promise<{ message?: string; run?: unknown }>;
  eveKill?(input: {
    sessionKey: string;
    runId: string;
  }): Promise<{ message?: string; run?: unknown }>;
  eveWrite?(input: {
    sessionKey: string;
    name: string;
    source: string;
    scope?: "project" | "user";
  }): Promise<{ message?: string; path?: string; meta?: unknown }>;
  eveAnswer?(input: {
    sessionKey: string;
    runId: string;
    answer: string;
  }): Promise<{ message?: string; run?: unknown }>;
  /** Dual-agent closeout review (optional). */
  reviewRun?(input: {
    sessionKey: string;
    mode?: "local" | "branch";
    protocol?: "panel" | "adversarial";
    agent_a?: string;
    agent_b?: string;
    base?: string;
    max_priority?: string;
  }): Promise<{
    message?: string;
    markdown?: string;
    resultPath?: string;
    bundleDir?: string;
    merged?: unknown;
  }>;
};

export type WorkerApiServer = {
  sockPath: string;
  listen(): Promise<void>;
  close(): Promise<void>;
};

function readBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.byteLength;
      if (n > maxBytes) {
        reject(new Error(`body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
    "cache-control": "no-store",
  });
  res.end(raw);
}

function parseUrl(req: IncomingMessage): { pathname: string } {
  try {
    const u = new URL(req.url || "/", "http://worker.local");
    return { pathname: u.pathname };
  } catch {
    return { pathname: "/" };
  }
}

export function createWorkerApiServer(options: {
  handlers: WorkerApiHandlers;
  sockPath?: string;
  stateDir?: string;
  log?: Logger;
}): WorkerApiServer {
  const log = (options.log ?? silentLogger()).child("worker-api");
  const sockPath =
    options.sockPath?.trim() ||
    workerApiSockPath(options.stateDir);

  let server: Server | undefined;

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { pathname } = parseUrl(req);
    const method = (req.method || "GET").toUpperCase();

    if (method === "GET" && pathname === "/v1/health") {
      sendJson(res, 200, { ok: true, message: "worker-api" });
      return;
    }

    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : "invalid json body",
      });
      return;
    }

    const sessionKey =
      typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
    if (!sessionKey) {
      sendJson(res, 400, { ok: false, error: "sessionKey required" });
      return;
    }

    try {
      if (pathname === "/v1/telegram/message") {
        const text = typeof body.text === "string" ? body.text : "";
        const kind = body.kind === "update" ? "update" : "message";
        if (!text.trim()) {
          sendJson(res, 400, { ok: false, error: "text required" });
          return;
        }
        const out = await options.handlers.sendMessage({
          sessionKey,
          text: text.trim(),
          kind,
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      if (pathname === "/v1/telegram/photo") {
        const path = typeof body.path === "string" ? body.path : "";
        if (!path.trim()) {
          sendJson(res, 400, { ok: false, error: "path required" });
          return;
        }
        const out = await options.handlers.sendPhoto({
          sessionKey,
          path: path.trim(),
          ...(typeof body.caption === "string"
            ? { caption: body.caption }
            : {}),
          ...(typeof body.filename === "string"
            ? { filename: body.filename }
            : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      if (pathname === "/v1/telegram/document") {
        const path = typeof body.path === "string" ? body.path : "";
        if (!path.trim()) {
          sendJson(res, 400, { ok: false, error: "path required" });
          return;
        }
        const out = await options.handlers.sendDocument({
          sessionKey,
          path: path.trim(),
          ...(typeof body.caption === "string"
            ? { caption: body.caption }
            : {}),
          ...(typeof body.filename === "string"
            ? { filename: body.filename }
            : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      if (pathname === "/v1/telegram/speak") {
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) {
          sendJson(res, 400, { ok: false, error: "text required" });
          return;
        }
        const out = await options.handlers.speak({
          sessionKey,
          text: text.trim(),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      if (pathname === "/v1/agents/spawn") {
        if (!options.handlers.agentSpawn) {
          sendJson(res, 501, { ok: false, error: "agent spawn not enabled" });
          return;
        }
        const name = typeof body.name === "string" ? body.name : "";
        if (!name.trim()) {
          sendJson(res, 400, { ok: false, error: "name required" });
          return;
        }
        const out = await options.handlers.agentSpawn({
          sessionKey,
          name: name.trim(),
          ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
          ...(typeof body.role === "string" ? { role: body.role } : {}),
          ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
          ...(typeof body.headless === "boolean"
            ? { headless: body.headless }
            : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/agents/list") {
        if (!options.handlers.agentList) {
          sendJson(res, 501, { ok: false, error: "agent list not enabled" });
          return;
        }
        const out = await options.handlers.agentList({ sessionKey });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/agents/kill") {
        if (!options.handlers.agentKill) {
          sendJson(res, 501, { ok: false, error: "agent kill not enabled" });
          return;
        }
        const out = await options.handlers.agentKill({
          sessionKey,
          ...(typeof body.childSessionKey === "string"
            ? { childSessionKey: body.childSessionKey }
            : {}),
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          ...(typeof body.dispose === "boolean" ? { dispose: body.dispose } : {}),
          ...(typeof body.remove_worktree === "boolean"
            ? { removeWorktree: body.remove_worktree }
            : typeof body.removeWorktree === "boolean"
              ? { removeWorktree: body.removeWorktree }
              : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/agents/send") {
        if (!options.handlers.agentSend) {
          sendJson(res, 501, { ok: false, error: "agent send not enabled" });
          return;
        }
        const to = typeof body.to === "string" ? body.to : "";
        const message = typeof body.message === "string" ? body.message : "";
        if (!to.trim() || !message.trim()) {
          sendJson(res, 400, { ok: false, error: "to and message required" });
          return;
        }
        const out = await options.handlers.agentSend({
          sessionKey,
          to: to.trim(),
          message: message.trim(),
          ...(body.mode === "steer" ? { mode: "steer" as const } : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/agents/wait") {
        if (!options.handlers.agentWait) {
          sendJson(res, 501, { ok: false, error: "agent wait not enabled" });
          return;
        }
        const out = await options.handlers.agentWait({
          sessionKey,
          ...(typeof body.childSessionKey === "string"
            ? { childSessionKey: body.childSessionKey }
            : {}),
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          ...(typeof body.to === "string" ? { to: body.to } : {}),
          ...(typeof body.timeout_sec === "number"
            ? { timeout_sec: body.timeout_sec }
            : {}),
          ...(typeof body.poll_sec === "number"
            ? { poll_sec: body.poll_sec }
            : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      // ── EVE ────────────────────────────────────────────────────────────
      if (pathname === "/v1/eve/run") {
        if (!options.handlers.eveRun) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const out = await options.handlers.eveRun({
          sessionKey,
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.path === "string" ? { path: body.path } : {}),
          ...(typeof body.source === "string" ? { source: body.source } : {}),
          ...(body.args !== undefined ? { args: body.args } : {}),
          ...(typeof body.skip_approval === "boolean"
            ? { skip_approval: body.skip_approval }
            : {}),
          ...(typeof body.agents_max === "number"
            ? { agents_max: body.agents_max }
            : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/eve/approve") {
        if (!options.handlers.eveApprove) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const runId = typeof body.runId === "string" ? body.runId : "";
        if (!runId) {
          sendJson(res, 400, { ok: false, error: "runId required" });
          return;
        }
        const out = await options.handlers.eveApprove({ sessionKey, runId });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/eve/status") {
        if (!options.handlers.eveStatus) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const runId = typeof body.runId === "string" ? body.runId : "";
        if (!runId) {
          sendJson(res, 400, { ok: false, error: "runId required" });
          return;
        }
        const out = await options.handlers.eveStatus({ sessionKey, runId });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/eve/list") {
        if (!options.handlers.eveList) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const out = await options.handlers.eveList({ sessionKey });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/eve/pause") {
        if (!options.handlers.evePause) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const runId = typeof body.runId === "string" ? body.runId : "";
        if (!runId) {
          sendJson(res, 400, { ok: false, error: "runId required" });
          return;
        }
        const out = await options.handlers.evePause({ sessionKey, runId });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/eve/resume") {
        if (!options.handlers.eveResume) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const runId = typeof body.runId === "string" ? body.runId : "";
        if (!runId) {
          sendJson(res, 400, { ok: false, error: "runId required" });
          return;
        }
        const out = await options.handlers.eveResume({ sessionKey, runId });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/eve/kill") {
        if (!options.handlers.eveKill) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const runId = typeof body.runId === "string" ? body.runId : "";
        if (!runId) {
          sendJson(res, 400, { ok: false, error: "runId required" });
          return;
        }
        const out = await options.handlers.eveKill({ sessionKey, runId });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/eve/answer") {
        if (!options.handlers.eveAnswer) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const runId = typeof body.runId === "string" ? body.runId : "";
        const answer = typeof body.answer === "string" ? body.answer : "";
        if (!runId || !answer.trim()) {
          sendJson(res, 400, { ok: false, error: "runId and answer required" });
          return;
        }
        const out = await options.handlers.eveAnswer({
          sessionKey,
          runId,
          answer,
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }
      if (pathname === "/v1/eve/write") {
        if (!options.handlers.eveWrite) {
          sendJson(res, 501, { ok: false, error: "EVE not enabled" });
          return;
        }
        const name = typeof body.name === "string" ? body.name : "";
        const source = typeof body.source === "string" ? body.source : "";
        if (!name.trim() || !source.trim()) {
          sendJson(res, 400, { ok: false, error: "name and source required" });
          return;
        }
        const out = await options.handlers.eveWrite({
          sessionKey,
          name: name.trim(),
          source,
          ...(body.scope === "user" || body.scope === "project"
            ? { scope: body.scope }
            : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      if (pathname === "/v1/review/run") {
        if (!options.handlers.reviewRun) {
          sendJson(res, 501, { ok: false, error: "review not enabled" });
          return;
        }
        const out = await options.handlers.reviewRun({
          sessionKey,
          ...(body.mode === "local" || body.mode === "branch"
            ? { mode: body.mode }
            : {}),
          ...(body.protocol === "panel" || body.protocol === "adversarial"
            ? { protocol: body.protocol }
            : {}),
          ...(typeof body.agent_a === "string" ? { agent_a: body.agent_a } : {}),
          ...(typeof body.agent_b === "string" ? { agent_b: body.agent_b } : {}),
          ...(typeof body.base === "string" ? { base: body.base } : {}),
          ...(typeof body.max_priority === "string"
            ? { max_priority: body.max_priority }
            : {}),
        });
        sendJson(res, 200, { ok: true, ...out });
        return;
      }

      sendJson(res, 404, { ok: false, error: `unknown path ${pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("handler error", { path: pathname, error: message });
      sendJson(res, 500, { ok: false, error: message });
    }
  }

  return {
    sockPath,
    async listen() {
      await mkdir(dirname(sockPath), { recursive: true });
      await unlink(sockPath).catch(() => {});
      server = createServer((req, res) => {
        void handle(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(sockPath, () => {
          server!.off("error", reject);
          resolve();
        });
      });
      log.info("listening", { sockPath });
    },
    async close() {
      const s = server;
      server = undefined;
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
      await unlink(sockPath).catch(() => {});
      log.info("closed", { sockPath });
    },
  };
}
