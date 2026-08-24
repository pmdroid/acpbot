/**
 * MCP OAuth flow orchestration: start PKCE, complete via callback or pasted code.
 *
 * Discovery (no per-gateway env client_id / auth URL):
 * 1. Protected-resource metadata (RFC 9728) via WWW-Authenticate or well-known
 * 2. Authorization server metadata (RFC 8414)
 * 3. Dynamic client registration (RFC 7591) for a public PKCE client
 *
 * Tokens + pending PKCE live under absolute `$ACPBOT_STATE_DIR` (worker + acp-host).
 * Authorize URL is returned for Telegram — host never opens a browser.
 */
import { resolve } from "node:path";
import {
  discoverMcpOAuth,
  registerOAuthClient,
} from "./oauth-discovery";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseCallbackPayload,
  refreshAccessToken,
  type TokenResponse,
} from "./oauth-pkce";
import {
  deletePendingForGateway,
  deletePendingOAuth,
  formatBearerHeader,
  isAccessTokenStale,
  pruneExpiredPendingOAuth,
  readOAuthToken,
  readPendingOAuth,
  repoKeyForOAuth,
  resolveOAuthStateDir,
  writeOAuthToken,
  writePendingOAuth,
  type McpOAuthPendingRecord,
  type McpOAuthTokenRecord,
} from "./oauth-store";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";

export type StartMcpAuthInput = {
  /** Gateway id from mcp.json (e.g. "github"). */
  id: string;
  /** Remote MCP URL from mcp.json. */
  resourceUrl: string;
  repoRoot: string;
  /** Configured repo key when available. */
  repoKey?: string;
  stateDir?: string;
  /**
   * Public base for redirects, e.g. https://host.ts.net:8788 or http://100.x.y.z:8788
   * Callback is `${base}/oauth/callback`.
   */
  callbackBase?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

export type StartMcpAuthResult = {
  authorizeUrl: string;
  redirectUri: string;
  state: string;
  repoKey: string;
  id: string;
  pendingPath: string;
  /** Discovered OAuth resource indicator. */
  resource: string;
  /** Scopes requested at authorize. */
  scopes: string[];
  clientId: string;
};

export type CompleteMcpAuthResult = {
  id: string;
  repoKey: string;
  tokenPath: string;
  record: McpOAuthTokenRecord;
};

/**
 * Normalize callback base: always include an explicit port for acpbot.
 * Bare `https://host` would otherwise redirect to :443 while we listen on :8788.
 */
export function normalizeOauthCallbackBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  try {
    const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    const u = new URL(withScheme);
    if (!u.port) {
      u.port = "8788";
    }
    // URL serializes https://host:8788 correctly; strip trailing slash
    return u.origin.replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export function oauthCallbackBase(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  const base = (override ?? env.ACPBOT_OAUTH_CALLBACK_BASE ?? "").trim();
  if (!base) {
    throw new Error(
      "ACPBOT_OAUTH_CALLBACK_BASE is not set (e.g. https://host.ts.net:8788 or http://100.x.y.z:8788). " +
        "Use Tailscale MagicDNS HTTPS or a reachable host IP so the provider can redirect.",
    );
  }
  return normalizeOauthCallbackBase(base);
}

export function oauthRedirectUri(callbackBase: string): string {
  return `${callbackBase.replace(/\/+$/, "")}/oauth/callback`;
}

/**
 * Listen port for the OAuth callback server.
 * Prefers ACPBOT_OAUTH_LISTEN_PORT, else the port in callback_base, else 8788.
 * (HTTPS MagicDNS still uses 8788 — not 443.)
 */
export function oauthListenPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = env.ACPBOT_OAUTH_LISTEN_PORT?.trim();
  if (explicit) {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0 && n < 65536) return Math.floor(n);
  }
  const base = env.ACPBOT_OAUTH_CALLBACK_BASE?.trim();
  if (base) {
    try {
      const u = new URL(base.includes("://") ? base : `http://${base}`);
      if (u.port) {
        const n = Number(u.port);
        if (Number.isFinite(n) && n > 0 && n < 65536) return Math.floor(n);
      }
    } catch {
      /* fall through */
    }
  }
  return 8788;
}

export function oauthListenHost(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.ACPBOT_OAUTH_LISTEN_HOST?.trim() || "0.0.0.0";
}

/** Optional TLS material for HTTPS OAuth callback (Tailscale cert, etc.). */
export function oauthTlsPaths(
  env: NodeJS.ProcessEnv = process.env,
): { cert: string; key: string } | null {
  const cert = env.ACPBOT_OAUTH_TLS_CERT?.trim() || env.TACP_OAUTH_TLS_CERT?.trim();
  const key = env.ACPBOT_OAUTH_TLS_KEY?.trim() || env.TACP_OAUTH_TLS_KEY?.trim();
  if (cert && key) return { cert, key };
  return null;
}

export function oauthCallbackIsHttps(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const base = env.ACPBOT_OAUTH_CALLBACK_BASE?.trim() ?? "";
  try {
    const u = new URL(base.includes("://") ? base : `http://${base}`);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Start PKCE: discover AS + DCR, store pending, return authorize URL for Telegram
 * (do not open browser on host).
 */
export async function startMcpOAuth(
  input: StartMcpAuthInput,
): Promise<StartMcpAuthResult> {
  const env = input.env ?? process.env;
  const stateDir = resolveOAuthStateDir(input.stateDir);
  const id = input.id.trim();
  if (!id) throw new Error("MCP id is required");

  const callbackBase = oauthCallbackBase(env, input.callbackBase);
  const redirectUri = oauthRedirectUri(callbackBase);
  const repoKey = repoKeyForOAuth(input.repoKey, input.repoRoot);
  const fetchImpl = input.fetchImpl ?? fetch;

  await pruneExpiredPendingOAuth(stateDir);
  await deletePendingForGateway(stateDir, id, repoKey);

  const discovered = await discoverMcpOAuth(input.resourceUrl, { fetchImpl });
  const client = await registerOAuthClient(
    discovered.registrationEndpoint,
    redirectUri,
    { fetchImpl },
  );

  const pkce = createPkcePair();
  const scope = discovered.scopes.join(" ");
  const pending: McpOAuthPendingRecord = {
    state: pkce.state,
    codeVerifier: pkce.codeVerifier,
    id,
    repoKey,
    repoRoot: resolve(input.repoRoot),
    redirectUri,
    clientId: client.client_id,
    authorizationEndpoint: discovered.authorizationEndpoint,
    tokenEndpoint: discovered.tokenEndpoint,
    createdAt: Date.now(),
    // Store discovered resource for token exchange (RFC 8707).
    resourceUrl: discovered.resource,
    scope,
    authorizationServer: discovered.authorizationServer,
    mcpUrl: input.resourceUrl,
  };

  const pendingPath = await writePendingOAuth(stateDir, pending);

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: discovered.authorizationEndpoint,
    clientId: client.client_id,
    redirectUri,
    state: pkce.state,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    scope,
    extraParams: { resource: discovered.resource },
  });

  return {
    authorizeUrl,
    redirectUri,
    state: pkce.state,
    repoKey,
    id,
    pendingPath,
    resource: discovered.resource,
    scopes: discovered.scopes,
    clientId: client.client_id,
  };
}

function tokenRecordFromResponse(
  pending: McpOAuthPendingRecord,
  tokens: TokenResponse,
): McpOAuthTokenRecord {
  const now = Date.now();
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? now + tokens.expires_in * 1000
      : undefined;
  const rec: McpOAuthTokenRecord = {
    id: pending.id,
    repoKey: pending.repoKey,
    accessToken: tokens.access_token,
    tokenType: tokens.token_type || "Bearer",
    createdAt: now,
    updatedAt: now,
  };
  if (tokens.refresh_token) rec.refreshToken = tokens.refresh_token;
  if (expiresAt !== undefined) rec.expiresAt = expiresAt;
  if (tokens.scope || pending.scope) {
    rec.scope = tokens.scope || pending.scope;
  }
  if (pending.resourceUrl) rec.resourceUrl = pending.resourceUrl;
  if (pending.clientId) rec.clientId = pending.clientId;
  if (pending.tokenEndpoint) rec.tokenEndpoint = pending.tokenEndpoint;
  if (pending.clientSecret) rec.clientSecret = pending.clientSecret;
  if (pending.authorizationServer) {
    rec.authorizationServer = pending.authorizationServer;
  }
  if (pending.mcpUrl) rec.mcpUrl = pending.mcpUrl;
  return rec;
}

/** Merge a refresh/token response onto an existing stored record. */
export function mergeTokenResponse(
  prev: McpOAuthTokenRecord,
  tokens: TokenResponse,
  now: number = Date.now(),
): McpOAuthTokenRecord {
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? now + tokens.expires_in * 1000
      : prev.expiresAt;
  const rec: McpOAuthTokenRecord = {
    ...prev,
    accessToken: tokens.access_token,
    tokenType: tokens.token_type || prev.tokenType || "Bearer",
    updatedAt: now,
  };
  // Keep previous refresh_token when provider omits a new one (common).
  if (tokens.refresh_token) {
    rec.refreshToken = tokens.refresh_token;
  } else if (prev.refreshToken) {
    rec.refreshToken = prev.refreshToken;
  }
  if (expiresAt !== undefined) rec.expiresAt = expiresAt;
  if (tokens.scope) rec.scope = tokens.scope;
  return rec;
}

/** In-flight refreshes keyed by stateDir|repoKey|id (process-local). */
const inflightRefresh = new Map<string, Promise<McpOAuthTokenRecord>>();

function refreshKey(stateDir: string, repoKey: string, id: string): string {
  return `${resolveOAuthStateDir(stateDir)}\0${repoKey}\0${id}`;
}

/**
 * Resolve token endpoint for refresh: stored field, else re-discover via mcpUrl.
 */
export async function resolveTokenEndpointForRefresh(
  record: McpOAuthTokenRecord,
  opts?: { fetchImpl?: typeof fetch },
): Promise<string> {
  if (record.tokenEndpoint?.trim()) return record.tokenEndpoint.trim();
  const mcpUrl = record.mcpUrl?.trim() || record.resourceUrl?.trim();
  if (!mcpUrl) {
    throw new Error(
      `MCP "${record.id}" token expired and no tokenEndpoint/mcpUrl to refresh; run /mcp auth ${record.id}`,
    );
  }
  const discovered = await discoverMcpOAuth(mcpUrl, {
    ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return discovered.tokenEndpoint;
}

/**
 * Refresh a stored OAuth token when stale. Writes the new record to disk.
 * Concurrent callers for the same id share one in-flight request.
 */
export async function refreshStoredOAuthToken(
  stateDir: string,
  repoKey: string,
  id: string,
  opts?: {
    fetchImpl?: typeof fetch;
    log?: Logger;
    now?: number;
    /** Force refresh even if not stale. */
    force?: boolean;
  },
): Promise<McpOAuthTokenRecord> {
  const abs = resolveOAuthStateDir(stateDir);
  const key = refreshKey(abs, repoKey, id);
  const existing = inflightRefresh.get(key);
  if (existing) return existing;

  const work = (async () => {
    const log = opts?.log ?? silentLogger();
    const now = opts?.now ?? Date.now();
    const record = await readOAuthToken(abs, repoKey, id);
    if (!record) {
      throw new Error(missingOAuthTokenMessage(id));
    }
    if (!opts?.force && !isAccessTokenStale(record, now)) {
      return record;
    }
    if (!record.refreshToken?.trim()) {
      throw new Error(
        `MCP "${id}" access token expired and no refresh_token stored; run /mcp auth ${id}`,
      );
    }
    if (!record.clientId?.trim()) {
      throw new Error(
        `MCP "${id}" cannot refresh (missing client_id); run /mcp auth ${id}`,
      );
    }

    let tokenEndpoint: string;
    try {
      tokenEndpoint = await resolveTokenEndpointForRefresh(record, {
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `MCP "${id}" token refresh failed (no token endpoint): ${msg}`,
      );
    }

    log.info("mcp oauth refreshing access token", { id, repoKey });

    let tokens: TokenResponse;
    try {
      tokens = await refreshAccessToken({
        tokenEndpoint,
        refreshToken: record.refreshToken,
        clientId: record.clientId,
        ...(record.clientSecret ? { clientSecret: record.clientSecret } : {}),
        ...(record.resourceUrl ? { resource: record.resourceUrl } : {}),
        ...(record.scope ? { scope: record.scope } : {}),
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // invalid_grant / revoked → operator must re-auth
      throw new Error(
        `MCP "${id}" token refresh failed: ${msg}. Run /mcp auth ${id}`,
      );
    }

    const next = mergeTokenResponse(record, tokens, now);
    // Persist resolved endpoint for next refresh (helps older records).
    if (!next.tokenEndpoint) next.tokenEndpoint = tokenEndpoint;
    await writeOAuthToken(abs, next);
    log.info("mcp oauth access token refreshed", {
      id,
      repoKey,
      expiresAt: next.expiresAt,
    });
    return next;
  })();

  inflightRefresh.set(key, work);
  try {
    return await work;
  } finally {
    inflightRefresh.delete(key);
  }
}

/**
 * Read token and refresh when stale. Returns Authorization header value.
 */
export async function ensureFreshBearerForMcp(
  stateDir: string,
  repoKey: string,
  id: string,
  opts?: {
    fetchImpl?: typeof fetch;
    log?: Logger;
    now?: number;
  },
): Promise<
  | { value: string; refreshed: boolean; record: McpOAuthTokenRecord }
  | undefined
> {
  const abs = resolveOAuthStateDir(stateDir);
  const now = opts?.now ?? Date.now();
  let record = await readOAuthToken(abs, repoKey, id);
  if (!record) return undefined;

  let refreshed = false;
  if (isAccessTokenStale(record, now)) {
    record = await refreshStoredOAuthToken(abs, repoKey, id, {
      ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts?.log ? { log: opts.log } : {}),
      now,
    });
    refreshed = true;
  }

  return {
    value: formatBearerHeader(record),
    refreshed,
    record,
  };
}

/**
 * Complete OAuth after callback: validate state, exchange code, store token, drop pending.
 */
export async function completeMcpOAuthCallback(
  input: {
    state: string;
    code?: string;
    error?: string;
    errorDescription?: string;
    stateDir?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<CompleteMcpAuthResult> {
  const stateDir = resolveOAuthStateDir(input.stateDir);
  const state = input.state?.trim();
  if (!state) throw new Error("missing OAuth state");

  if (input.error) {
    await deletePendingOAuth(stateDir, state).catch(() => {});
    throw new Error(
      `OAuth denied: ${input.error}${input.errorDescription ? ` — ${input.errorDescription}` : ""}`,
    );
  }

  const code = input.code?.trim();
  if (!code) throw new Error("missing OAuth code");

  const pending = await readPendingOAuth(stateDir, state);
  if (!pending) {
    throw new Error(
      "invalid or expired OAuth state (no pending PKCE or past 15m TTL; run /mcp auth <id> again)",
    );
  }

  if (pending.state !== state) {
    throw new Error("OAuth state mismatch");
  }

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: pending.tokenEndpoint,
    code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.codeVerifier,
    clientId: pending.clientId,
    ...(pending.resourceUrl ? { resource: pending.resourceUrl } : {}),
    ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

  const record = tokenRecordFromResponse(pending, tokens);
  const tokenPath = await writeOAuthToken(stateDir, record, {
    repoRoot: pending.repoRoot,
  });
  await deletePendingOAuth(stateDir, state);

  return {
    id: pending.id,
    repoKey: pending.repoKey,
    tokenPath,
    record,
  };
}

/**
 * Fallback when redirect cannot reach the host: paste callback URL or code.
 * Prefer the **full** redirect URL (`code` + `state`).
 */
export async function completeMcpOAuthFromPaste(
  input: {
    callbackUrlOrCode: string;
    id?: string;
    repoKey?: string;
    stateDir?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<CompleteMcpAuthResult> {
  const stateDir = resolveOAuthStateDir(input.stateDir);
  const parsed = parseCallbackPayload(input.callbackUrlOrCode);

  if (parsed.error) {
    if (parsed.state) {
      await deletePendingOAuth(stateDir, parsed.state).catch(() => {});
    }
    throw new Error(
      `OAuth denied: ${parsed.error}${parsed.errorDescription ? ` — ${parsed.errorDescription}` : ""}`,
    );
  }

  if (parsed.state && parsed.code) {
    return completeMcpOAuthCallback({
      state: parsed.state,
      code: parsed.code,
      stateDir,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  }

  if (parsed.state && !parsed.code) {
    throw new Error("callback missing code parameter");
  }

  if (parsed.code && input.id) {
    const pending = await findLatestPendingForId(
      stateDir,
      input.id.trim(),
      input.repoKey,
    );
    if (!pending) {
      throw new Error(
        `no pending OAuth for "${input.id}"; run /mcp auth ${input.id} first (15m TTL)`,
      );
    }
    return completeMcpOAuthCallback({
      state: pending.state,
      code: parsed.code,
      stateDir,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  }

  throw new Error(
    "could not parse callback — prefer the full redirect URL (with code & state), " +
      "or `/mcp code <code> <id>` after /mcp auth",
  );
}

async function findLatestPendingForId(
  stateDir: string,
  id: string,
  repoKey?: string,
): Promise<McpOAuthPendingRecord | undefined> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { isPendingExpired, oauthStorePaths } = await import("./oauth-store");
  const paths = oauthStorePaths(stateDir);
  let names: string[];
  try {
    names = await readdir(paths.pending);
  } catch {
    return undefined;
  }

  let best: McpOAuthPendingRecord | undefined;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const text = await readFile(`${paths.pending}/${name}`, "utf8");
      const rec = JSON.parse(text) as McpOAuthPendingRecord;
      if (rec.id !== id) continue;
      if (repoKey && rec.repoKey !== repoKey) continue;
      if (isPendingExpired(rec)) continue;
      if (!best || rec.createdAt > best.createdAt) best = rec;
    } catch {
      /* skip */
    }
  }
  return best;
}

/** Clear message used when ensure would attach a remote MCP without a token. */
export function missingOAuthTokenMessage(id: string): string {
  return `MCP "${id}" has no OAuth token; run /mcp auth ${id}`;
}
