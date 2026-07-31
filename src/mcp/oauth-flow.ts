/**
 * MCP OAuth flow orchestration: start PKCE, complete via callback or pasted code.
 *
 * Discovery is intentionally light for MVP:
 * 1. Env overrides: TACP_MCP_OAUTH_<ID>_AUTH_URL / _TOKEN_URL / _CLIENT_ID / _SCOPE
 * 2. Optional well-known OAuth AS metadata at resource origin
 * 3. Common pattern fallbacks (same origin /authorize + /token)
 *
 * Some gateways need explicit metadata via env — document that in README.
 */
import { resolve } from "node:path";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseCallbackPayload,
  type TokenResponse,
} from "./oauth-pkce";
import {
  deletePendingForGateway,
  deletePendingOAuth,
  pruneExpiredPendingOAuth,
  readPendingOAuth,
  repoKeyForOAuth,
  resolveOAuthStateDir,
  writeOAuthToken,
  writePendingOAuth,
  type McpOAuthPendingRecord,
  type McpOAuthTokenRecord,
} from "./oauth-store";

export type OAuthEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
};

export type StartMcpAuthInput = {
  /** Gateway id from mcp.json (e.g. "linear"). */
  id: string;
  /** Remote MCP URL from mcp.json. */
  resourceUrl: string;
  repoRoot: string;
  /** Configured repo key when available. */
  repoKey?: string;
  stateDir?: string;
  /**
   * Public base for redirects, e.g. https://host.ts.net or http://100.x.y.z:8788
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
};

export type CompleteMcpAuthResult = {
  id: string;
  repoKey: string;
  tokenPath: string;
  record: McpOAuthTokenRecord;
};

/** Env key segment: LINEAR from id "linear". */
function envIdSegment(id: string): string {
  return id
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Resolve OAuth endpoints for a gateway.
 * Prefers env overrides; otherwise attempts lightweight discovery.
 */
export async function resolveOAuthEndpoints(
  id: string,
  resourceUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthEndpoints> {
  const seg = envIdSegment(id);
  const authUrl = env[`TACP_MCP_OAUTH_${seg}_AUTH_URL`]?.trim();
  const tokenUrl = env[`TACP_MCP_OAUTH_${seg}_TOKEN_URL`]?.trim();
  const clientId =
    env[`TACP_MCP_OAUTH_${seg}_CLIENT_ID`]?.trim() ||
    env.TACP_MCP_OAUTH_CLIENT_ID?.trim() ||
    "tacp";
  const clientSecret =
    env[`TACP_MCP_OAUTH_${seg}_CLIENT_SECRET`]?.trim() ||
    env.TACP_MCP_OAUTH_CLIENT_SECRET?.trim();
  const scope =
    env[`TACP_MCP_OAUTH_${seg}_SCOPE`]?.trim() ||
    env.TACP_MCP_OAUTH_SCOPE?.trim();

  if (authUrl && tokenUrl) {
    return {
      authorizationEndpoint: authUrl,
      tokenEndpoint: tokenUrl,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(scope ? { scope } : {}),
    };
  }

  // Try OAuth Authorization Server Metadata (RFC 8414) at resource origin.
  let parsed: URL;
  try {
    parsed = new URL(resourceUrl);
  } catch {
    throw new Error(
      `invalid MCP url for OAuth: ${resourceUrl}. Set TACP_MCP_OAUTH_${seg}_AUTH_URL and _TOKEN_URL.`,
    );
  }

  const origin = parsed.origin;
  const wellKnownUrls = [
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration`,
  ];

  for (const wk of wellKnownUrls) {
    try {
      const res = await fetchImpl(wk, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) continue;
      const meta = (await res.json()) as Record<string, unknown>;
      const authorizationEndpoint =
        typeof meta.authorization_endpoint === "string"
          ? meta.authorization_endpoint
          : undefined;
      const tokenEndpoint =
        typeof meta.token_endpoint === "string"
          ? meta.token_endpoint
          : undefined;
      if (authorizationEndpoint && tokenEndpoint) {
        return {
          authorizationEndpoint: authUrl || authorizationEndpoint,
          tokenEndpoint: tokenUrl || tokenEndpoint,
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          ...(scope ? { scope } : {}),
        };
      }
    } catch {
      // try next
    }
  }

  if (authUrl || tokenUrl) {
    throw new Error(
      `incomplete OAuth env for "${id}": set both TACP_MCP_OAUTH_${seg}_AUTH_URL and TACP_MCP_OAUTH_${seg}_TOKEN_URL`,
    );
  }

  // Last-resort common pattern (many simple gateways).
  return {
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(scope ? { scope } : {}),
  };
}

export function oauthCallbackBase(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  const base = (override ?? env.TACP_OAUTH_CALLBACK_BASE ?? "").trim();
  if (!base) {
    throw new Error(
      "TACP_OAUTH_CALLBACK_BASE is not set (e.g. https://host.ts.net or http://100.x.y.z:8788). " +
        "Use Tailscale Serve / Funnel or a reachable host IP so the provider can redirect.",
    );
  }
  return base.replace(/\/+$/, "");
}

export function oauthRedirectUri(callbackBase: string): string {
  return `${callbackBase.replace(/\/+$/, "")}/oauth/callback`;
}

/** Parse listen port from TACP_OAUTH_CALLBACK_BASE (default 8788). */
export function oauthListenPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = env.TACP_OAUTH_LISTEN_PORT?.trim();
  if (explicit) {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0 && n < 65536) return Math.floor(n);
  }
  const base = env.TACP_OAUTH_CALLBACK_BASE?.trim();
  if (base) {
    try {
      const u = new URL(base.includes("://") ? base : `http://${base}`);
      if (u.port) return Number(u.port);
      return u.protocol === "https:" ? 443 : 80;
    } catch {
      /* fall through */
    }
  }
  return 8788;
}

export function oauthListenHost(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.TACP_OAUTH_LISTEN_HOST?.trim() || "0.0.0.0";
}

/**
 * Start PKCE: store pending, return authorize URL for Telegram (do not open browser on host).
 * Prunes expired pending and clears prior pending for the same id+repoKey.
 */
export async function startMcpOAuth(
  input: StartMcpAuthInput,
): Promise<StartMcpAuthResult> {
  const env = input.env ?? process.env;
  // Always absolute so worker and acp-host agree regardless of CWD.
  const stateDir = resolveOAuthStateDir(input.stateDir);
  const id = input.id.trim();
  if (!id) throw new Error("MCP id is required");

  const callbackBase = oauthCallbackBase(env, input.callbackBase);
  const redirectUri = oauthRedirectUri(callbackBase);
  const repoKey = repoKeyForOAuth(input.repoKey, input.repoRoot);

  await pruneExpiredPendingOAuth(stateDir);
  // One in-flight flow per gateway — reduces bare-code ambiguity.
  await deletePendingForGateway(stateDir, id, repoKey);

  const endpoints = await resolveOAuthEndpoints(
    id,
    input.resourceUrl,
    env,
    input.fetchImpl ?? fetch,
  );

  const pkce = createPkcePair();
  const pending: McpOAuthPendingRecord = {
    state: pkce.state,
    codeVerifier: pkce.codeVerifier,
    id,
    repoKey,
    repoRoot: resolve(input.repoRoot),
    redirectUri,
    clientId: endpoints.clientId,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
    createdAt: Date.now(),
    resourceUrl: input.resourceUrl,
    ...(endpoints.clientSecret ? { clientSecret: endpoints.clientSecret } : {}),
    ...(endpoints.scope ? { scope: endpoints.scope } : {}),
  };

  const pendingPath = await writePendingOAuth(stateDir, pending);

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: endpoints.authorizationEndpoint,
    clientId: endpoints.clientId,
    redirectUri,
    state: pkce.state,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    ...(endpoints.scope ? { scope: endpoints.scope } : {}),
    // MCP OAuth resource indicator when useful
    extraParams: input.resourceUrl
      ? { resource: input.resourceUrl }
      : undefined,
  });

  return {
    authorizeUrl,
    redirectUri,
    state: pkce.state,
    repoKey,
    id,
    pendingPath,
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
  if (tokens.scope) rec.scope = tokens.scope;
  if (pending.resourceUrl) rec.resourceUrl = pending.resourceUrl;
  return rec;
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

  // readPendingOAuth drops expired (TTL) records.
  const pending = await readPendingOAuth(stateDir, state);
  if (!pending) {
    throw new Error(
      "invalid or expired OAuth state (no pending PKCE or past 15m TTL; run /mcp auth <id> again)",
    );
  }

  // Constant-time-ish compare for state (already key lookup); re-check field.
  if (pending.state !== state) {
    throw new Error("OAuth state mismatch");
  }

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: pending.tokenEndpoint,
    code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.codeVerifier,
    clientId: pending.clientId,
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
 * `/mcp code <callback-url-or-code> [id]`
 *
 * Prefer the **full** redirect URL (`code` + `state`). Bare code + id is a
 * last resort (uses latest non-expired pending for that id after `/mcp auth`
 * cleared prior pendings for the same gateway).
 */
export async function completeMcpOAuthFromPaste(
  input: {
    callbackUrlOrCode: string;
    /** Required for bare code (uses most recent non-expired pending for id). */
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

  // Preferred: full URL with state (CSRF-bound).
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

  // Bare code — require id; pending was unique after /mcp auth for that gateway.
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
