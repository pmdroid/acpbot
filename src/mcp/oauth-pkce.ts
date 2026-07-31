/**
 * OAuth2 PKCE helpers (RFC 7636) for remote MCP auth.
 * Pure crypto / URL construction — no network, no disk.
 */
import { createHash, randomBytes } from "node:crypto";

const VERIFIER_BYTES = 32;
const STATE_BYTES = 24;

/** URL-safe base64 without padding (RFC 7636). */
export function base64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** High-entropy code_verifier (43–128 chars after encoding). */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(VERIFIER_BYTES));
}

/** S256 code_challenge = BASE64URL(SHA256(verifier)). */
export function codeChallengeS256(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier, "utf8").digest());
}

/** Opaque CSRF state for the authorize redirect. */
export function generateOAuthState(): string {
  return base64Url(randomBytes(STATE_BYTES));
}

export type PkcePair = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
};

export function createPkcePair(): PkcePair {
  const codeVerifier = generateCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: codeChallengeS256(codeVerifier),
    codeChallengeMethod: "S256",
    state: generateOAuthState(),
  };
}

export type BuildAuthorizeUrlInput = {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod?: "S256" | "plain";
  scope?: string;
  /** Extra query params (e.g. resource, audience). */
  extraParams?: Record<string, string>;
};

/** Build the browser/Telegram authorize URL (does not open a browser). */
export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const u = new URL(input.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.codeChallenge);
  u.searchParams.set(
    "code_challenge_method",
    input.codeChallengeMethod ?? "S256",
  );
  if (input.scope?.trim()) {
    u.searchParams.set("scope", input.scope.trim());
  }
  if (input.extraParams) {
    for (const [k, v] of Object.entries(input.extraParams)) {
      if (v != null && v !== "") u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

export type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  /** Preserve unknown fields from the provider. */
  raw?: Record<string, unknown>;
};

export type ExchangeCodeInput = {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  /** Optional confidential-client secret (unused for public DCR clients). */
  clientSecret?: string;
  /** RFC 8707 resource indicator (MCP OAuth). */
  resource?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Exchange authorization code for tokens (authorization_code + PKCE).
 * Throws on non-2xx or missing access_token.
 */
export async function exchangeAuthorizationCode(
  input: ExchangeCodeInput,
): Promise<TokenResponse> {
  const fetchFn = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret) {
    body.set("client_secret", input.clientSecret);
  }
  if (input.resource?.trim()) {
    body.set("resource", input.resource.trim());
  }

  const res = await fetchFn(input.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(
      `token endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const errDesc =
      typeof parsed.error_description === "string"
        ? parsed.error_description
        : typeof parsed.error === "string"
          ? parsed.error
          : text.slice(0, 200);
    throw new Error(`token exchange failed (${res.status}): ${errDesc}`);
  }

  const access =
    typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!access) {
    throw new Error("token exchange response missing access_token");
  }

  const out: TokenResponse = {
    access_token: access,
    raw: parsed,
  };
  if (typeof parsed.token_type === "string") out.token_type = parsed.token_type;
  if (typeof parsed.expires_in === "number") out.expires_in = parsed.expires_in;
  if (typeof parsed.refresh_token === "string") {
    out.refresh_token = parsed.refresh_token;
  }
  if (typeof parsed.scope === "string") out.scope = parsed.scope;
  return out;
}

/**
 * Parse `code` and `state` from a full callback URL or from a bare code string.
 * Bare code → `{ code, state: undefined }`.
 */
export function parseCallbackPayload(input: string): {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
} {
  const raw = input.trim();
  if (!raw) return {};

  // Full URL with query
  if (/^https?:\/\//i.test(raw) || raw.includes("://") || raw.includes("?")) {
    try {
      const u = raw.includes("://")
        ? new URL(raw)
        : new URL(raw, "http://localhost");
      const code = u.searchParams.get("code") ?? undefined;
      const state = u.searchParams.get("state") ?? undefined;
      const error = u.searchParams.get("error") ?? undefined;
      const errorDescription =
        u.searchParams.get("error_description") ?? undefined;
      return {
        ...(code !== undefined ? { code } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(errorDescription !== undefined ? { errorDescription } : {}),
      };
    } catch {
      // fall through to bare code
    }
  }

  // Bare authorization code
  return { code: raw };
}
