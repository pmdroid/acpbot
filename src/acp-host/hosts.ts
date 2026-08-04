/**
 * Multi-host catalog: local Unix (default) or remote WSS with bearer token.
 *
 * Config:
 *   [hosts.local]          # optional; implied when omitted
 *   [hosts.studio]
 *   kind = "wss"
 *   url = "wss://studio.example.com:8790"
 *   token = "secret"  # or "env:ACPBOT_HOST_TOKEN_STUDIO"
 *
 *   [repos.work]
 *   path = "/data/work"
 *   host = "studio"
 *
 * String form repos still mean host=local:
 *   work = "/data/work"
 */

export type HostKind = "unix" | "wss";

export type HostEndpointConfig = {
  id: string;
  kind: HostKind;
  /** Unix socket path (kind=unix). */
  sockPath?: string;
  /** WebSocket URL wss:// or ws:// (kind=wss; tests may use ws). */
  url?: string;
  /** Shared secret; required for wss. */
  token?: string;
};

export type RepoBinding = {
  path: string;
  /** Host catalog id; default "local". */
  hostId: string;
};

export type HostsCatalog = {
  hosts: Record<string, HostEndpointConfig>;
  /** repoKey → path + hostId */
  repos: Record<string, RepoBinding>;
};

/** Resolve `env:VAR` token indirection. */
export function resolveTokenRef(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (raw == null) return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (t.startsWith("env:")) {
    const key = t.slice(4).trim();
    return env[key]?.trim() || undefined;
  }
  return t;
}

/**
 * Parse TOML-ish hosts + repos tables into a catalog.
 * `rawHosts` is the [hosts] table; `rawRepos` is the [repos] table.
 */
export function parseHostsCatalog(input: {
  rawHosts?: Record<string, unknown>;
  rawRepos?: Record<string, unknown>;
  /** Default unix sock when kind=unix and sock omitted. */
  defaultSockPath?: string;
  env?: NodeJS.ProcessEnv;
}): HostsCatalog {
  const env = input.env ?? process.env;
  const hosts: Record<string, HostEndpointConfig> = {};

  // Always ensure a local host entry.
  hosts.local = {
    id: "local",
    kind: "unix",
    sockPath: input.defaultSockPath,
  };

  if (input.rawHosts && typeof input.rawHosts === "object") {
    for (const [id, v] of Object.entries(input.rawHosts)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const t = v as Record<string, unknown>;
      const kindRaw = String(t.kind ?? t.type ?? "unix").trim().toLowerCase();
      const kind: HostKind =
        kindRaw === "wss" || kindRaw === "ws" || kindRaw === "websocket"
          ? "wss"
          : "unix";
      const url = t.url != null ? String(t.url).trim() : undefined;
      const sockPath =
        t.sock != null
          ? String(t.sock).trim()
          : t.sock_path != null
            ? String(t.sock_path).trim()
            : t.sockPath != null
              ? String(t.sockPath).trim()
              : undefined;
      const tokenRaw =
        t.token != null
          ? String(t.token)
          : t.auth_token != null
            ? String(t.auth_token)
            : undefined;
      hosts[id] = {
        id,
        kind,
        ...(sockPath ? { sockPath } : id === "local" && input.defaultSockPath
          ? { sockPath: input.defaultSockPath }
          : {}),
        ...(url ? { url } : {}),
        ...(resolveTokenRef(tokenRaw, env)
          ? { token: resolveTokenRef(tokenRaw, env) }
          : {}),
      };
    }
  }

  // Single-remote env override (simple ops path).
  const envUrl = env.ACPBOT_ACP_HOST_URL?.trim();
  const envToken = env.ACPBOT_HOST_TOKEN?.trim();
  if (envUrl) {
    hosts.remote = {
      id: "remote",
      kind: "wss",
      url: envUrl,
      ...(envToken ? { token: envToken } : {}),
    };
  }

  const repos: Record<string, RepoBinding> = {};
  if (input.rawRepos && typeof input.rawRepos === "object") {
    for (const [key, v] of Object.entries(input.rawRepos)) {
      if (typeof v === "string") {
        const path = v.trim();
        if (!path) continue;
        repos[key] = { path, hostId: "local" };
        continue;
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const t = v as Record<string, unknown>;
        const path = String(t.path ?? t.cwd ?? "").trim();
        if (!path) continue;
        const hostId = String(t.host ?? t.host_id ?? t.hostId ?? "local").trim() ||
          "local";
        repos[key] = { path, hostId };
      }
    }
  }

  return { hosts, repos };
}

/** Flatten catalog repos to path-only map (scheduler / legacy). */
export function reposPathsOnly(
  catalog: HostsCatalog | { repos: Record<string, RepoBinding> },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(catalog.repos)) {
    out[k] = v.path;
  }
  return out;
}

/**
 * Resolve which host runs a session.
 * Order: explicit hostId → repo binding → local.
 * Never falls back from a configured remote to local.
 */
export function resolveHostId(input: {
  sessionHostId?: string | null;
  repoKey?: string;
  catalog: HostsCatalog;
}): string {
  if (input.sessionHostId?.trim()) {
    const id = input.sessionHostId.trim();
    if (!input.catalog.hosts[id]) {
      throw new Error(
        `unknown host id "${id}" (configured: ${Object.keys(input.catalog.hosts).join(", ") || "none"})`,
      );
    }
    return id;
  }
  if (input.repoKey?.trim()) {
    const binding = input.catalog.repos[input.repoKey.trim()];
    if (binding) {
      const id = binding.hostId || "local";
      if (!input.catalog.hosts[id]) {
        throw new Error(
          `repo "${input.repoKey}" binds host "${id}" but that host is not in [hosts]`,
        );
      }
      return id;
    }
  }
  return "local";
}

export function getHostEndpoint(
  catalog: HostsCatalog,
  hostId: string,
): HostEndpointConfig {
  const h = catalog.hosts[hostId];
  if (!h) {
    throw new Error(`unknown host "${hostId}"`);
  }
  if (h.kind === "wss") {
    if (!h.url?.trim()) {
      throw new Error(`host "${hostId}" (wss) missing url`);
    }
    if (!h.token?.trim()) {
      throw new Error(
        `host "${hostId}" (wss) missing token — set token or ACPBOT_HOST_TOKEN`,
      );
    }
  }
  return h;
}
