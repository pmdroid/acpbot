/**
 * Small HTTP listener for MCP OAuth callbacks.
 *
 *   GET /oauth/callback?code=&state=  — complete PKCE, store tokens
 *   GET /oauth/status                 — liveness (no secrets)
 *
 * Bind address/port from ACPBOT_OAUTH_LISTEN_* or derived from ACPBOT_OAUTH_CALLBACK_BASE.
 * Started by acp-host (preferred) when callback base is configured.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import {
  completeMcpOAuthCallback,
  oauthListenHost,
  oauthListenPort,
} from "../mcp/oauth-flow";
import { resolveOAuthStateDir } from "../mcp/oauth-store";

export type OauthHttpServerOptions = {
  stateDir?: string;
  host?: string;
  port?: number;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

export type OauthHttpServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/html; charset=utf-8",
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function htmlPage(title: string, message: string, ok: boolean): string {
  const color = ok ? "#0a0" : "#a00";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
  h1{font-size:1.25rem;color:${color}}
  code{background:#f4f4f4;padding:0.1em 0.35em;border-radius:4px}
  .muted{color:#666;font-size:0.9rem}
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${message}</p>
  <p class="muted">You can close this tab and return to Telegram.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readQuery(req: IncomingMessage): URLSearchParams {
  try {
    const host = req.headers.host || "localhost";
    const u = new URL(req.url || "/", `http://${host}`);
    return u.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pathName(req: IncomingMessage): string {
  try {
    const host = req.headers.host || "localhost";
    return new URL(req.url || "/", `http://${host}`).pathname;
  } catch {
    return "/";
  }
}

/**
 * Start the OAuth callback HTTP server.
 * No-ops are not done here — caller decides whether to start based on env.
 */
export async function startOauthHttpServer(
  options: OauthHttpServerOptions = {},
): Promise<OauthHttpServer> {
  const env = options.env ?? process.env;
  const log = (options.log ?? silentLogger()).child("oauth-http");
  // Absolute path — must match worker's /mcp auth pending store.
  const stateDir = resolveOAuthStateDir(options.stateDir);
  const host = options.host ?? oauthListenHost(env);
  const port = options.port ?? oauthListenPort(env);

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || "GET").toUpperCase();
    const path = pathName(req);

    if (method === "GET" && (path === "/oauth/status" || path === "/healthz")) {
      send(
        res,
        200,
        JSON.stringify({ ok: true, service: "acpbot-oauth" }),
        "application/json; charset=utf-8",
      );
      return;
    }

    if (method === "GET" && path === "/oauth/callback") {
      const q = readQuery(req);
      const state = q.get("state") ?? "";
      const code = q.get("code") ?? undefined;
      const error = q.get("error") ?? undefined;
      const errorDescription = q.get("error_description") ?? undefined;

      if (!state) {
        send(
          res,
          400,
          htmlPage(
            "OAuth failed",
            "Missing <code>state</code> query parameter. Run <code>/mcp auth &lt;id&gt;</code> again in Telegram.",
            false,
          ),
        );
        return;
      }

      try {
        const result = await completeMcpOAuthCallback({
          state,
          ...(code !== undefined ? { code } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(errorDescription !== undefined ? { errorDescription } : {}),
          stateDir,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        log.info("oauth callback ok", {
          id: result.id,
          repoKey: result.repoKey,
        });
        send(
          res,
          200,
          htmlPage(
            "MCP authorized",
            `Gateway <code>${escapeHtml(result.id)}</code> is connected. ` +
              `Return to Telegram — tokens are stored on the host (not in the repo). ` +
              `Active on next session ensure / restart.`,
            true,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("oauth callback failed", { error: msg, state: state.slice(0, 8) });
        send(
          res,
          400,
          htmlPage(
            "OAuth failed",
            escapeHtml(msg) +
              " — try <code>/mcp auth &lt;id&gt;</code> again, or use " +
              "<code>/mcp code &lt;url&gt;</code> if this host is not reachable from the browser.",
            false,
          ),
        );
      }
      return;
    }

    send(
      res,
      404,
      htmlPage(
        "Not found",
        "acpbot OAuth listener. Expected <code>GET /oauth/callback</code>.",
        false,
      ),
    );
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  log.info("oauth http listening", { host, port, stateDir });

  return {
    host,
    port,
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Start OAuth HTTP only when ACPBOT_OAUTH_CALLBACK_BASE is set.
 * Returns null when OAuth is not configured.
 */
export async function maybeStartOauthHttpServer(
  options: OauthHttpServerOptions = {},
): Promise<OauthHttpServer | null> {
  const env = options.env ?? process.env;
  if (!env.ACPBOT_OAUTH_CALLBACK_BASE?.trim()) return null;
  return startOauthHttpServer(options);
}
