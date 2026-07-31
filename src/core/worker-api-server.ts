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
