/**
 * Host HTTP API — Unix socket only.
 * MCP children POST here with a host-minted Bearer token. sessionKey is routing.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import type {
  ComputerAction,
  ComputerActionResult,
  ComputerSupervisor,
} from "../computer/supervisor";

export const HOST_API_SOCK_NAME = "host-api.sock";
export const HOST_API_BODY_MAX = 64 * 1024;

export function hostApiSockPath(
  stateDir = process.env.ACPBOT_STATE_DIR?.trim() || "./data/acpbot-state",
): string {
  const fromEnv = process.env.ACPBOT_HOST_API_SOCK?.trim();
  if (fromEnv) return fromEnv;
  return join(stateDir.replace(/\/$/, ""), HOST_API_SOCK_NAME);
}

export function mintHostApiToken(): string {
  return randomBytes(32).toString("base64url");
}

export type HostApiServer = {
  sockPath: string;
  listen(): Promise<void>;
  close(): Promise<void>;
};

export type HostApiAuth = {
  /** Resolve the per-slot host-minted token. Missing → 401. */
  tokenFor(sessionKey: string): string | undefined;
};

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
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

function parseUrl(req: IncomingMessage): {
  pathname: string;
  searchParams: URLSearchParams;
} {
  try {
    const u = new URL(req.url || "/", "http://host-api.local");
    return { pathname: u.pathname, searchParams: u.searchParams };
  } catch {
    return { pathname: "/", searchParams: new URLSearchParams() };
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return undefined;
  const m = /^Bearer\s+(\S+)/i.exec(raw.trim());
  return m?.[1];
}

function actionFromPath(
  pathname: string,
  body: Record<string, unknown>,
): ComputerAction | undefined {
  const name = pathname.replace(/^\/v1\/computer\//, "");
  if (name === "status") return { type: "status" };
  if (name === "screenshot") {
    const region =
      body.region && typeof body.region === "object"
        ? (body.region as { x: number; y: number; w: number; h: number })
        : undefined;
    return {
      type: "screenshot",
      ...(typeof body.display === "number" ? { display: body.display } : {}),
      ...(region ? { region } : {}),
    };
  }
  if (name === "navigate") {
    return { type: "navigate", url: String(body.url ?? "") };
  }
  if (name === "click") {
    return {
      type: "click",
      x: Number(body.x),
      y: Number(body.y),
      ...(body.button === "left" ||
      body.button === "right" ||
      body.button === "middle"
        ? { button: body.button }
        : {}),
    };
  }
  if (name === "move") {
    return { type: "move", x: Number(body.x), y: Number(body.y) };
  }
  if (name === "drag") {
    return {
      type: "drag",
      x1: Number(body.x1),
      y1: Number(body.y1),
      x2: Number(body.x2),
      y2: Number(body.y2),
    };
  }
  if (name === "scroll") {
    return {
      type: "scroll",
      x: Number(body.x),
      y: Number(body.y),
      ...(body.dx != null ? { dx: Number(body.dx) } : {}),
      ...(body.dy != null ? { dy: Number(body.dy) } : {}),
    };
  }
  if (name === "type") {
    return { type: "type", text: String(body.text ?? "") };
  }
  if (name === "key") {
    const mods = Array.isArray(body.modifiers)
      ? body.modifiers.map((m) => String(m))
      : undefined;
    return {
      type: "key",
      key: String(body.key ?? ""),
      ...(mods ? { modifiers: mods } : {}),
    };
  }
  return undefined;
}

function resultToJson(result: ComputerActionResult): Record<string, unknown> {
  if (!result.ok) return { ok: false, error: result.error };
  const out: Record<string, unknown> = { ok: true, action: result.action };
  if (result.frameId) out.frameId = result.frameId;
  if (result.width != null) out.width = result.width;
  if (result.height != null) out.height = result.height;
  if (result.jpeg) out.jpegBase64 = Buffer.from(result.jpeg).toString("base64");
  if (result.status) out.status = result.status;
  return out;
}

export function createHostApiServer(options: {
  supervisor: ComputerSupervisor;
  auth: HostApiAuth;
  sockPath?: string;
  stateDir?: string;
  log?: Logger;
}): HostApiServer {
  const log = (options.log ?? silentLogger()).child("host-api");
  const sockPath =
    options.sockPath?.trim() || hostApiSockPath(options.stateDir);
  let server: Server | undefined;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname, searchParams } = parseUrl(req);
    const method = (req.method ?? "GET").toUpperCase();

    if (pathname === "/v1/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!pathname.startsWith("/v1/computer/")) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    let body: Record<string, unknown> = {};
    if (method !== "GET" && method !== "HEAD") {
      try {
        const raw = await readBody(req, HOST_API_BODY_MAX);
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            sendJson(res, 400, { ok: false, error: "invalid json" });
            return;
          }
          body = parsed as Record<string, unknown>;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(
          res,
          msg.includes("too large") ? 413 : 400,
          { ok: false, error: msg },
        );
        return;
      }
    }

    const sessionKey = String(
      body.sessionKey ?? searchParams.get("sessionKey") ?? "",
    ).trim();
    if (!sessionKey) {
      sendJson(res, 400, { ok: false, error: "sessionKey required" });
      return;
    }

    const presented = bearerToken(req);
    const expected = options.auth.tokenFor(sessionKey);
    if (!presented || !expected || presented !== expected) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const action = actionFromPath(pathname, body);
    if (!action) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    const result = await options.supervisor.act(sessionKey, action);
    sendJson(res, result.ok ? 200 : 403, resultToJson(result));
  };

  return {
    sockPath,
    async listen() {
      await mkdir(dirname(sockPath), { recursive: true });
      if (existsSync(sockPath)) {
        try {
          unlinkSync(sockPath);
        } catch {
          /* */
        }
      }
      server = createServer((req, res) => {
        void handle(req, res).catch((err) => {
          log.warn("host-api handler failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: "internal" });
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(sockPath, () => {
          server!.off("error", reject);
          try {
            chmodSync(sockPath, 0o600);
          } catch {
            /* defense-in-depth only */
          }
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
        const t = setTimeout(resolve, 1000);
        s.close(() => {
          clearTimeout(t);
          resolve();
        });
        const closer = s as Server & { closeAllConnections?: () => void };
        closer.closeAllConnections?.();
      });
      try {
        unlinkSync(sockPath);
      } catch {
        /* */
      }
      log.info("closed", { sockPath });
    },
  };
}
