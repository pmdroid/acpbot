/**
 * MCP OAuth discovery + dynamic client registration.
 *
 * Modern remote MCP gateways expect clients to:
 * 1. Discover the protected resource (RFC 9728) — often via WWW-Authenticate
 *    on an unauthenticated MCP probe, or `/.well-known/oauth-protected-resource…`
 * 2. Resolve the authorization server metadata (RFC 8414)
 * 3. Register a public PKCE client at `registration_endpoint` (RFC 7591 DCR)
 *
 * No per-gateway AUTH_URL / CLIENT_ID env overrides — endpoints and client_id
 * come from the gateway itself.
 */
import type { Logger } from "../env/logger";

const CLIENT_UA = "acpbot-mcp-oauth/0.1";

/**
 * Full, multi-line OAuth HTTP error for Telegram (do not mid-string truncate).
 * Parses standard OAuth JSON error bodies when present.
 */
export function formatOAuthHttpFailure(
  what: string,
  res: { status: number; text: string; json: unknown },
  extra?: Record<string, string>,
): string {
  const lines = [`${what} failed (HTTP ${res.status}).`];
  const j = res.json as Record<string, unknown> | null;
  if (j && typeof j === "object") {
    if (typeof j.error === "string") lines.push(`Error: ${j.error}`);
    if (typeof j.error_description === "string") {
      lines.push(j.error_description);
    } else if (typeof j.error_uri === "string") {
      lines.push(`Details: ${j.error_uri}`);
    } else if (!j.error && res.text.trim()) {
      lines.push(res.text.trim().slice(0, 1500));
    }
  } else if (res.text.trim()) {
    lines.push(res.text.trim().slice(0, 1500));
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

export type ProtectedResourceMeta = {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  resource_name?: string;
};

export type AuthorizationServerMeta = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
};

export type DiscoveredOAuth = {
  /** OAuth resource indicator (may differ from the MCP URL). */
  resource: string;
  /** Authorization server issuer URL. */
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scopes: string[];
  resourceName?: string;
};

export type RegisteredClient = {
  client_id: string;
  client_id_issued_at?: number;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  client_name?: string;
};

export type HttpJsonResult<T> = {
  status: number;
  headers: Headers;
  json: T | null;
  text: string;
};

export async function httpJson<T>(
  url: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpJsonResult<T>> {
  const headers = new Headers(init?.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", CLIENT_UA);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const res = await fetchImpl(url, { ...init, headers });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** RFC 9728 well-known path for a MCP resource URL. */
export function protectedResourceMetaUrl(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`;
}

/** RFC 8414 well-known for an issuer that may include a path. */
export function authorizationServerMetaUrl(issuer: string): string {
  const clean = issuer.replace(/\/$/, "");
  const issuerUrl = new URL(clean);
  return `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname === "/" ? "" : issuerUrl.pathname}`;
}

function pickScopes(
  as: AuthorizationServerMeta,
  resourceMeta?: ProtectedResourceMeta,
): string[] {
  const fromAs = as.scopes_supported ?? [];
  const fromPr = resourceMeta?.scopes_supported ?? [];
  const candidates = [...fromAs, ...fromPr];
  const preferred = candidates.filter(
    (s) => s === "mcp" || s === "offline_access",
  );
  if (preferred.length > 0) {
    const out = [...new Set(preferred)];
    if (!out.includes("mcp") && candidates.includes("mcp")) out.unshift("mcp");
    return out;
  }
  // Gateway advertised nothing useful — request common MCP scopes.
  return ["mcp", "offline_access"];
}

/**
 * Discover OAuth endpoints for a remote MCP URL.
 * Throws with a clear message when discovery fails.
 */
export async function discoverMcpOAuth(
  mcpUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    log?: Logger;
  } = {},
): Promise<DiscoveredOAuth> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let resource = mcpUrl;
  let asIssuer: string | undefined;
  let prMeta: ProtectedResourceMeta | undefined;

  let parsedMcp: URL;
  try {
    parsedMcp = new URL(mcpUrl);
  } catch {
    throw new Error(`invalid MCP url for OAuth: ${mcpUrl}`);
  }

  // 1) Probe MCP — many gateways return WWW-Authenticate with resource_metadata.
  try {
    const probe = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": CLIENT_UA,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "acpbot", version: "0.1" },
        },
      }),
    });
    const www = probe.headers.get("www-authenticate") || "";
    const metaMatch = www.match(/resource_metadata="([^"]+)"/i);
    if (metaMatch?.[1]) {
      const pr = await httpJson<ProtectedResourceMeta>(
        metaMatch[1],
        undefined,
        fetchImpl,
      );
      if (pr.json) {
        prMeta = pr.json;
        if (pr.json.resource) resource = pr.json.resource;
        if (pr.json.authorization_servers?.[0]) {
          asIssuer = pr.json.authorization_servers[0];
        }
      }
    }
  } catch (err) {
    options.log?.debug("mcp oauth: MCP probe failed (will try well-known)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2) Fallback: protected-resource well-known at MCP origin+path
  if (!asIssuer) {
    const prUrl = protectedResourceMetaUrl(mcpUrl);
    const pr = await httpJson<ProtectedResourceMeta>(prUrl, undefined, fetchImpl);
    if (pr.json) {
      prMeta = pr.json;
      if (pr.json.resource) resource = pr.json.resource;
      if (pr.json.authorization_servers?.[0]) {
        asIssuer = pr.json.authorization_servers[0];
      }
    }
  }

  // 3) Last fallback: assume the MCP origin is also the AS issuer
  if (!asIssuer) {
    asIssuer = parsedMcp.origin;
  }

  // 4) Authorization server metadata
  const asMetaUrls = [
    authorizationServerMetaUrl(asIssuer),
    `${new URL(asIssuer.replace(/\/$/, "")).origin}/.well-known/openid-configuration`,
  ];

  let as: AuthorizationServerMeta | null = null;
  let usedAsUrl = "";
  for (const url of asMetaUrls) {
    const res = await httpJson<AuthorizationServerMeta>(url, undefined, fetchImpl);
    if (
      res.json?.authorization_endpoint &&
      res.json?.token_endpoint
    ) {
      as = res.json;
      usedAsUrl = url;
      break;
    }
  }

  if (!as?.authorization_endpoint || !as.token_endpoint) {
    throw new Error(
      `OAuth discovery failed for ${mcpUrl}: no authorization_endpoint/token_endpoint ` +
        `(tried ${asMetaUrls.join(", ")}). Gateway must publish RFC 8414 AS metadata.`,
    );
  }

  if (!as.registration_endpoint) {
    throw new Error(
      `OAuth discovery failed for ${mcpUrl}: AS has no registration_endpoint ` +
        `(dynamic client registration required; metadata from ${usedAsUrl}).`,
    );
  }

  const scopes = pickScopes(as, prMeta);
  const out: DiscoveredOAuth = {
    resource,
    authorizationServer: asIssuer.replace(/\/$/, ""),
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    scopes,
  };
  if (prMeta?.resource_name) out.resourceName = prMeta.resource_name;
  return out;
}

/**
 * Register a public PKCE client (RFC 7591) for the redirect URI.
 * `token_endpoint_auth_method: none` — no client secret.
 */
export async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
  options: {
    fetchImpl?: typeof fetch;
    clientName?: string;
  } = {},
): Promise<RegisteredClient> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = {
    client_name: options.clientName ?? "acpbot (Telegram MCP OAuth)",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  };
  const res = await httpJson<
    RegisteredClient & { error?: string; error_description?: string }
  >(
    registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    fetchImpl,
  );
  if (res.status >= 300 || !res.json?.client_id) {
    throw new Error(formatOAuthHttpFailure("dynamic client registration", res, {
      redirect_uri: redirectUri,
    }));
  }
  return {
    client_id: res.json.client_id,
    client_id_issued_at: res.json.client_id_issued_at,
    redirect_uris: res.json.redirect_uris || [redirectUri],
    token_endpoint_auth_method: res.json.token_endpoint_auth_method,
    client_name: res.json.client_name,
  };
}
