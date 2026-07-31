/**
 * MCP OAuth flow orchestration: start PKCE, complete via callback or pasted code.
 *
 * Discovery (no per-gateway env client_id / auth URL):
 * 1. Protected-resource metadata (RFC 9728) via WWW-Authenticate or well-known
 * 2. Authorization server metadata (RFC 8414)
 * 3. Dynamic client registration (RFC 7591) for a public PKCE client
 *
 * Tokens + pending PKCE live under absolute `$TACP_ACPX_STATE_DIR` (worker + acp-host).
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
  if (pending.authorizationServer) {
    rec.authorizationServer = pending.authorizationServer;
  }
  if (pending.mcpUrl) rec.mcpUrl = pending.mcpUrl;
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
