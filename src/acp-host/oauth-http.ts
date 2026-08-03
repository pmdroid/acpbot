/**
 * HTTP(S) listener for MCP OAuth callbacks.
 *
 *   GET /oauth/callback?code=&state=  — complete PKCE, store tokens
 *   GET /oauth/status                 — liveness (no secrets)
 *
 * Bind address/port from ACPBOT_OAUTH_LISTEN_* or derived from ACPBOT_OAUTH_CALLBACK_BASE.
 * Default port is always 8788. When callback_base is https:// (MagicDNS) and
 * Tailscale certs are available, serves HTTPS on that same port.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import {
  completeMcpOAuthCallback,
  oauthCallbackIsHttps,
  oauthListenHost,
  oauthListenPort,
  oauthTlsPaths,
} from "../mcp/oauth-flow";
import { resolveOAuthStateDir } from "../mcp/oauth-store";
import {
  findTailscaleCertPair,
  parseTailscaleStatusJson,
  stripDnsTrailingDots,
} from "../setup/oauth-callback-detect";
import { spawnSync } from "node:child_process";

export type OauthHttpServerOptions = {
  stateDir?: string;
  host?: string;
  port?: number;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Override TLS paths (tests). */
  tls?: { cert: string; key: string } | null;
  /**
   * Called after tokens are stored. Host should drop live agent slots for
   * `repoKey` so the next ensure rebuilds MCP with the new Bearer.
   */
  onAuthorized?: (info: {
    id: string;
    repoKey: string;
  }) => void | Promise<void>;
};

export type OauthHttpServer = {
  host: string;
  port: number;
  url: string;
  /** True when TLS cert/key are loaded. */
  tls: boolean;
  close: () => Promise<void>;
};

function resolveTlsMaterial(
  env: NodeJS.ProcessEnv,
  override?: { cert: string; key: string } | null,
): { cert: Buffer; key: Buffer; certPath: string; keyPath: string } | null {
  // Explicit opt-out (tests / force plain HTTP)
  if (override === null) return null;

  const wantHttps = oauthCallbackIsHttps(env);
  let certPath = override?.cert ?? oauthTlsPaths(env)?.cert;
  let keyPath = override?.key ?? oauthTlsPaths(env)?.key;

  // Auto-detect Tailscale certs only when callback_base is https://.
  // Do not flip plain http:// callbacks to HTTPS just because certs exist on disk.
  if ((!certPath || !keyPath) && wantHttps) {
    const base = env.ACPBOT_OAUTH_CALLBACK_BASE?.trim() ?? "";
    let dns: string | undefined;
    try {
      const u = new URL(base.includes("://") ? base : `https://${base}`);
      if (u.hostname.endsWith(".ts.net")) dns = stripDnsTrailingDots(u.hostname);
    } catch {
      /* ignore */
    }
    if (!dns) {
      try {
        const r = spawnSync("tailscale", ["status", "--json"], {
          encoding: "utf8",
          timeout: 3000,
        });
        if (r.status === 0 && r.stdout) {
          dns = parseTailscaleStatusJson(r.stdout).dnsName;
        }
      } catch {
        /* ignore */
      }
    }
    if (dns) {
      const pair = findTailscaleCertPair(dns, env);
      if (pair) {
        certPath = pair.certPath;
        keyPath = pair.keyPath;
      }
    }
  }

  // Plain HTTP callback and no explicit TLS paths → plain HTTP server
  if (!certPath || !keyPath) {
    if (wantHttps) return null; // caller throws with setup help
    return null;
  }

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(
      `OAuth TLS files missing:\n  cert: ${certPath}\n  key:  ${keyPath}\n` +
        `Issue with: tailscale cert <MagicDNS>  (store under ~/.local/share/tailscale-certs/)`,
    );
  }
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    certPath,
    keyPath,
  };
}

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

  const wantHttps = oauthCallbackIsHttps(env);
  let tlsMat: ReturnType<typeof resolveTlsMaterial> = null;
  try {
    tlsMat = resolveTlsMaterial(env, options.tls);
  } catch (err) {
    if (wantHttps) throw err;
    log.warn("oauth TLS config ignored", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (wantHttps && !tlsMat) {
    throw new Error(
      "OAuth callback_base is https:// but no TLS cert/key found.\n" +
        "  Set oauth.tls_cert / oauth.tls_key, or place Tailscale certs at:\n" +
        "  ~/.local/share/tailscale-certs/<MagicDNS>.crt and .key\n" +
        "  mkdir -p ~/.local/share/tailscale-certs && cd $_ && tailscale cert <dns>",
    );
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  };
  const server: HttpServer | HttpsServer = tlsMat
    ? createHttpsServer({ cert: tlsMat.cert, key: tlsMat.key }, onRequest)
    : createHttpServer(onRequest);

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
        if (options.onAuthorized) {
          try {
            await options.onAuthorized({
              id: result.id,
              repoKey: result.repoKey,
            });
          } catch (hookErr) {
            log.warn("oauth onAuthorized hook failed", {
              error:
                hookErr instanceof Error ? hookErr.message : String(hookErr),
            });
          }
        }
        send(
          res,
          200,
          htmlPage(
            "MCP authorized",
            `Gateway <code>${escapeHtml(result.id)}</code> is connected. ` +
              `Return to Telegram and use the tools — the per-topic MCP proxy ` +
              `picks up the token without restarting the agent.`,
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

  const scheme = tlsMat ? "https" : "http";
  const url = `${scheme}://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  log.info("oauth http listening", {
    host,
    port,
    stateDir,
    tls: Boolean(tlsMat),
    ...(tlsMat
      ? { certPath: tlsMat.certPath, keyPath: tlsMat.keyPath }
      : {}),
  });

  return {
    host,
    port,
    url,
    tls: Boolean(tlsMat),
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
