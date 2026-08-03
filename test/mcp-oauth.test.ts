import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  base64Url,
  buildAuthorizeUrl,
  codeChallengeS256,
  createPkcePair,
  generateCodeVerifier,
  parseCallbackPayload,
} from "../src/mcp/oauth-pkce";
import {
  assertNotRepoPath,
  bearerForMcp,
  isPendingExpired,
  oauthStorePaths,
  PENDING_OAUTH_TTL_MS,
  readOAuthToken,
  readPendingOAuth,
  repoKeyForOAuth,
  resolveOAuthStateDir,
  writeOAuthToken,
  writePendingOAuth,
} from "../src/mcp/oauth-store";
import {
  completeMcpOAuthCallback,
  completeMcpOAuthFromPaste,
  missingOAuthTokenMessage,
  startMcpOAuth,
} from "../src/mcp/oauth-flow";
import {
  applyOAuthTokensToServers,
  buildSessionMcpServers,
  formatMcpRegistryStatus,
} from "../src/mcp/repo-mcp";
import { startOauthHttpServer } from "../src/acp-host/oauth-http";
import type { AcpbotMcpRemoteServer } from "../src/mcp/repo-mcp";

async function withTempDirs(
  run: (dirs: { state: string; repo: string }) => Promise<void>,
) {
  const state = await mkdtemp(join(tmpdir(), "acpbot-oauth-state-"));
  const repo = await mkdtemp(join(tmpdir(), "acpbot-oauth-repo-"));
  try {
    await run({ state, repo });
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
}

describe("oauth-pkce", () => {
  test("verifier and S256 challenge are stable shapes", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    const challenge = codeChallengeS256(v);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(v);
    // deterministic
    expect(codeChallengeS256(v)).toBe(challenge);
  });

  test("createPkcePair + buildAuthorizeUrl", () => {
    const p = createPkcePair();
    const url = buildAuthorizeUrl({
      authorizationEndpoint: "https://auth.example/authorize",
      clientId: "acpbot",
      redirectUri: "http://100.1.2.3:8788/oauth/callback",
      state: p.state,
      codeChallenge: p.codeChallenge,
      scope: "mcp",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://auth.example/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(p.codeChallenge);
    expect(u.searchParams.get("state")).toBe(p.state);
    expect(u.searchParams.get("redirect_uri")).toContain("/oauth/callback");
  });

  test("parseCallbackPayload from full URL and bare code", () => {
    const full = parseCallbackPayload(
      "http://100.1.2.3:8788/oauth/callback?code=abc&state=xyz",
    );
    expect(full).toEqual({ code: "abc", state: "xyz" });
    expect(parseCallbackPayload("just-the-code")).toEqual({
      code: "just-the-code",
    });
    const err = parseCallbackPayload(
      "https://x/oauth/callback?error=access_denied&error_description=nope&state=s",
    );
    expect(err.error).toBe("access_denied");
    expect(err.state).toBe("s");
  });

  test("base64Url has no padding", () => {
    expect(base64Url(Buffer.from("hi"))).not.toContain("=");
  });
});

describe("oauth-store", () => {
  test("resolveOAuthStateDir is always absolute", () => {
    const abs = resolveOAuthStateDir("./relative-state");
    expect(isAbsolute(abs)).toBe(true);
    expect(abs).toBe(resolve("./relative-state"));
    const already = resolveOAuthStateDir("/tmp/absolute-oauth");
    expect(already).toBe("/tmp/absolute-oauth");
  });

  test("tokens land under state dir, never under repo .acpbot; mode 0600", async () => {
    await withTempDirs(async ({ state, repo }) => {
      const repoKey = repoKeyForOAuth("demo", repo);
      const path = await writeOAuthToken(
        state,
        {
          id: "linear",
          repoKey,
          accessToken: "tok-secret",
          tokenType: "Bearer",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        { repoRoot: repo },
      );

      expect(path.startsWith(state)).toBe(true);
      expect(isAbsolute(path)).toBe(true);
      expect(path.includes(`${join("mcp-oauth", "by-repo")}`)).toBe(true);
      expect(path.includes(join(".acpbot"))).toBe(false);
      expect(path.includes(repo)).toBe(false);

      const st = await stat(path);
      // On unix: owner read/write only (0600). Skip strict check on platforms
      // that don't honor mode (Windows).
      if (process.platform !== "win32") {
        expect(st.mode & 0o777).toBe(0o600);
      }

      // Repo mcp.json must not receive the token
      await mkdir(join(repo, ".acpbot"), { recursive: true });
      await writeFile(
        join(repo, ".acpbot", "mcp.json"),
        JSON.stringify({
          mcpServers: [
            { name: "linear", type: "http", url: "https://mcp.example/linear" },
          ],
        }),
        "utf8",
      );
      const mcpRaw = await readFile(join(repo, ".acpbot", "mcp.json"), "utf8");
      expect(mcpRaw).not.toContain("tok-secret");
      expect(mcpRaw).not.toContain("accessToken");

      const rec = await readOAuthToken(state, repoKey, "linear");
      expect(rec?.accessToken).toBe("tok-secret");

      const auth = await bearerForMcp(state, repoKey, "linear");
      expect(auth?.value).toBe("Bearer tok-secret");
    });
  });

  test("assertNotRepoPath rejects .acpbot token paths", () => {
    expect(() =>
      assertNotRepoPath("/repo/.acpbot/mcp-oauth/x.json", "/repo"),
    ).toThrow(/refusing/);
    expect(() =>
      assertNotRepoPath("/repo/.acpbot/mcp.json", "/repo"),
    ).toThrow(/refusing/);
  });

  test("repoKey prefers configured key else hash", () => {
    expect(repoKeyForOAuth("demo", "/any/path")).toBe("demo");
    const a = repoKeyForOAuth(undefined, "/tmp/foo");
    const b = repoKeyForOAuth(undefined, "/tmp/foo");
    const c = repoKeyForOAuth(undefined, "/tmp/bar");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  test("pending PKCE TTL: expired records are dropped", async () => {
    await withTempDirs(async ({ state, repo }) => {
      const old = Date.now() - PENDING_OAUTH_TTL_MS - 1000;
      await writePendingOAuth(state, {
        state: "expired-state",
        codeVerifier: generateCodeVerifier(),
        id: "linear",
        repoKey: "demo",
        repoRoot: repo,
        redirectUri: "http://127.0.0.1:9/oauth/callback",
        clientId: "acpbot",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        createdAt: old,
      });
      expect(isPendingExpired({ createdAt: old })).toBe(true);
      const got = await readPendingOAuth(state, "expired-state");
      expect(got).toBeUndefined();

      await expect(
        completeMcpOAuthCallback({
          state: "expired-state",
          code: "x",
          stateDir: state,
        }),
      ).rejects.toThrow(/invalid or expired|15m TTL/i);
    });
  });
});

describe("oauth callback state validation", () => {
  test("rejects unknown state", async () => {
    await withTempDirs(async ({ state }) => {
      await expect(
        completeMcpOAuthCallback({
          state: "no-such-state",
          code: "code",
          stateDir: state,
        }),
      ).rejects.toThrow(/invalid or expired OAuth state/);
    });
  });

  test("rejects missing code", async () => {
    await withTempDirs(async ({ state, repo }) => {
      await writePendingOAuth(state, {
        state: "st1",
        codeVerifier: generateCodeVerifier(),
        id: "linear",
        repoKey: "demo",
        repoRoot: repo,
        redirectUri: "http://127.0.0.1:9/oauth/callback",
        clientId: "acpbot",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        createdAt: Date.now(),
      });
      await expect(
        completeMcpOAuthCallback({ state: "st1", stateDir: state }),
      ).rejects.toThrow(/missing OAuth code/);
    });
  });

  test("happy path: exchange + store + consume pending", async () => {
    await withTempDirs(async ({ state, repo }) => {
      const verifier = generateCodeVerifier();
      await writePendingOAuth(state, {
        state: "good-state",
        codeVerifier: verifier,
        id: "linear",
        repoKey: "demo",
        repoRoot: repo,
        redirectUri: "http://127.0.0.1:9/oauth/callback",
        clientId: "acpbot",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        createdAt: Date.now(),
        resourceUrl: "https://mcp.example/linear",
      });

      const fetchImpl: typeof fetch = async (input, init) => {
        expect(String(input)).toBe("https://auth.example/token");
        const body = String(init?.body ?? "");
        expect(body).toContain("code=the-code");
        expect(body).toContain(`code_verifier=${encodeURIComponent(verifier)}`);
        return new Response(
          JSON.stringify({
            access_token: "access-xyz",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-xyz",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const result = await completeMcpOAuthCallback({
        state: "good-state",
        code: "the-code",
        stateDir: state,
        fetchImpl,
      });
      expect(result.id).toBe("linear");
      expect(result.record.accessToken).toBe("access-xyz");
      expect(result.record.refreshToken).toBe("refresh-xyz");

      // pending consumed
      await expect(
        completeMcpOAuthCallback({
          state: "good-state",
          code: "again",
          stateDir: state,
          fetchImpl,
        }),
      ).rejects.toThrow(/invalid or expired/);

      // token not under repo
      expect(result.tokenPath.startsWith(state)).toBe(true);
      expect(result.tokenPath.includes(repo)).toBe(false);
    });
  });

  test("paste fallback with full callback URL", async () => {
    await withTempDirs(async ({ state, repo }) => {
      const verifier = generateCodeVerifier();
      await writePendingOAuth(state, {
        state: "paste-state",
        codeVerifier: verifier,
        id: "gql",
        repoKey: "demo",
        repoRoot: repo,
        redirectUri: "http://127.0.0.1:9/oauth/callback",
        clientId: "acpbot",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        createdAt: Date.now(),
      });

      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({ access_token: "from-paste", token_type: "bearer" }),
          { status: 200 },
        );

      const result = await completeMcpOAuthFromPaste({
        callbackUrlOrCode:
          "http://127.0.0.1:9/oauth/callback?code=c1&state=paste-state",
        stateDir: state,
        fetchImpl,
      });
      expect(result.record.accessToken).toBe("from-paste");
      const auth = await bearerForMcp(state, "demo", "gql");
      expect(auth?.value).toBe("Bearer from-paste");
    });
  });
});

describe("status auth notes", () => {
  test("omits auth notes when oauthEnabled is false", () => {
    const text = formatMcpRegistryStatus(
      {
        mcpServers: [
          { name: "linear", type: "http", url: "https://mcp.example/linear" },
        ],
      },
      undefined,
      { oauthEnabled: false, tokenIds: [] },
    );
    expect(text).toContain("linear");
    expect(text).not.toContain("auth: missing");
    expect(text).not.toContain("auth: ok");
  });

  test("shows auth missing when oauthEnabled and no token", () => {
    const text = formatMcpRegistryStatus(
      {
        mcpServers: [
          { name: "linear", type: "http", url: "https://mcp.example/linear" },
        ],
      },
      undefined,
      { oauthEnabled: true, tokenIds: [] },
    );
    expect(text).toContain("auth: missing");
  });
});

describe("merge OAuth headers into remote MCP", () => {
  test("applyOAuthTokensToServers injects Authorization", async () => {
    await withTempDirs(async ({ state }) => {
      await writeOAuthToken(state, {
        id: "linear",
        repoKey: "demo",
        accessToken: "hdr-token",
        tokenType: "Bearer",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const servers: AcpbotMcpRemoteServer[] = [
        {
          type: "http",
          name: "linear",
          url: "https://mcp.example/linear",
          headers: [{ name: "X-Custom", value: "1" }],
        },
      ];
      const out = await applyOAuthTokensToServers(servers, {
        stateDir: state,
        repoKey: "demo",
        failClosed: true,
      });
      expect(out).toHaveLength(1);
      const remote = out[0] as AcpbotMcpRemoteServer;
      expect(remote.headers).toContainEqual({
        name: "Authorization",
        value: "Bearer hdr-token",
      });
      expect(remote.headers).toContainEqual({ name: "X-Custom", value: "1" });
    });
  });

  test("fail closed when remote has no token", async () => {
    await withTempDirs(async ({ state }) => {
      const servers: AcpbotMcpRemoteServer[] = [
        {
          type: "http",
          name: "linear",
          url: "https://mcp.example/linear",
          headers: [],
        },
      ];
      await expect(
        applyOAuthTokensToServers(servers, {
          stateDir: state,
          repoKey: "demo",
          failClosed: true,
        }),
      ).rejects.toThrow(missingOAuthTokenMessage("linear"));
    });
  });

  test("buildSessionMcpServers merges Bearer for remote", async () => {
    await withTempDirs(async ({ state, repo }) => {
      await mkdir(join(repo, ".acpbot"), { recursive: true });
      await writeFile(
        join(repo, ".acpbot", "mcp.json"),
        JSON.stringify({
          mcpServers: [
            {
              name: "linear",
              type: "http",
              url: "https://mcp.example/linear",
            },
          ],
        }),
        "utf8",
      );
      await writeOAuthToken(state, {
        id: "linear",
        repoKey: "demo",
        accessToken: "session-tok",
        tokenType: "Bearer",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const servers = await buildSessionMcpServers({
        cwd: repo,
        enabled: true,
        sessionKey: "demo/main",
        repoKey: "demo",
        stateDir: state,
        oauthStateDir: state,
        oauthFailClosed: true,
      });

      const linear = servers.find((s) => s.name === "linear") as {
        type: string;
        headers: Array<{ name: string; value: string }>;
      };
      expect(linear?.type).toBe("http");
      expect(linear.headers).toContainEqual({
        name: "Authorization",
        value: "Bearer session-tok",
      });

      // Still must not have written token into repo
      const mcpRaw = await readFile(join(repo, ".acpbot", "mcp.json"), "utf8");
      expect(mcpRaw).not.toContain("session-tok");
      expect(mcpRaw).not.toContain("Authorization");
    });
  });
});

/** Mock fetch: protected-resource + AS metadata + DCR for a fake gateway. */
function mockDiscoverFetch(opts?: {
  clientId?: string;
  resource?: string;
}): typeof fetch {
  const clientId = opts?.clientId ?? "dyn-client-xyz";
  const resource = opts?.resource ?? "https://mcp.example/linear";
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    // MCP probe — return WWW-Authenticate resource_metadata
    if (url === "https://mcp.example/linear" && method === "POST") {
      return new Response("{}", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="mcp", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/linear"',
        },
      });
    }
    if (url.includes("oauth-protected-resource")) {
      return new Response(
        JSON.stringify({
          resource,
          authorization_servers: ["https://auth.example"],
          scopes_supported: ["mcp", "offline_access"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: "https://auth.example",
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
          registration_endpoint: "https://auth.example/register",
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["mcp", "offline_access"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://auth.example/register" && method === "POST") {
      return new Response(
        JSON.stringify({
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: "none",
          redirect_uris: ["http://100.9.9.9:8788/oauth/callback"],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://auth.example/token" && method === "POST") {
      return new Response(
        JSON.stringify({
          access_token: "via-discover",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
}

describe("startMcpOAuth + oauth-http callback", () => {
  test("start discovers AS + DCR (no env client_id / auth URL)", async () => {
    await withTempDirs(async ({ state, repo }) => {
      const env: NodeJS.ProcessEnv = {
        ACPBOT_OAUTH_CALLBACK_BASE: "http://100.9.9.9:8788",
      };
      const started = await startMcpOAuth({
        id: "linear",
        resourceUrl: "https://mcp.example/linear",
        repoRoot: repo,
        repoKey: "demo",
        stateDir: state,
        env,
        fetchImpl: mockDiscoverFetch({ clientId: "dyn-client-xyz" }),
      });
      expect(started.authorizeUrl).toContain("https://auth.example/authorize");
      expect(started.authorizeUrl).toContain("code_challenge");
      expect(started.authorizeUrl).toContain("client_id=dyn-client-xyz");
      expect(started.authorizeUrl).toContain(
        encodeURIComponent("https://mcp.example/linear"),
      );
      expect(started.clientId).toBe("dyn-client-xyz");
      expect(started.redirectUri).toBe(
        "http://100.9.9.9:8788/oauth/callback",
      );
      expect(started.pendingPath.startsWith(state)).toBe(true);
      expect(started.pendingPath.includes(repo)).toBe(false);
      const paths = oauthStorePaths(state);
      expect(started.pendingPath.startsWith(paths.pending)).toBe(true);
      // no static env client id path
      expect(started.authorizeUrl).not.toContain("client_id=acpbot&");
    });
  });

  test("HTTP callback validates state and stores token", async () => {
    await withTempDirs(async ({ state, repo }) => {
      const verifier = generateCodeVerifier();
      await writePendingOAuth(state, {
        state: "http-state",
        codeVerifier: verifier,
        id: "linear",
        repoKey: "demo",
        repoRoot: repo,
        redirectUri: "http://127.0.0.1/oauth/callback",
        clientId: "acpbot",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        createdAt: Date.now(),
      });

      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({ access_token: "via-http", token_type: "Bearer" }),
          { status: 200 },
        );

      // Bind ephemeral port
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
      const addr = probe.address();
      const port =
        addr && typeof addr === "object" ? addr.port : 0;
      await new Promise<void>((r, j) => probe.close((e) => (e ? j(e) : r())));

      const oauth = await startOauthHttpServer({
        stateDir: state,
        host: "127.0.0.1",
        port,
        fetchImpl,
        // Force plain HTTP — ignore any host env/Tailscale certs
        tls: null,
        env: {
          ...process.env,
          ACPBOT_OAUTH_CALLBACK_BASE: "http://127.0.0.1",
          TACP_OAUTH_CALLBACK_BASE: "http://127.0.0.1",
          ACPBOT_OAUTH_TLS_CERT: "",
          ACPBOT_OAUTH_TLS_KEY: "",
          TACP_OAUTH_TLS_CERT: "",
          TACP_OAUTH_TLS_KEY: "",
        },
      });
      try {
        // bad state
        const bad = await fetch(
          `${oauth.url}/oauth/callback?code=x&state=wrong`,
        );
        expect(bad.status).toBe(400);
        expect(await bad.text()).toMatch(/invalid or expired|OAuth failed/i);

        // good
        const ok = await fetch(
          `${oauth.url}/oauth/callback?code=the-code&state=http-state`,
        );
        expect(ok.status).toBe(200);
        expect(await ok.text()).toMatch(/MCP authorized|linear/i);

        const tok = await readOAuthToken(state, "demo", "linear");
        expect(tok?.accessToken).toBe("via-http");

        const status = await fetch(`${oauth.url}/oauth/status`);
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({ ok: true });
      } finally {
        await oauth.close();
      }
    });
  });
});
