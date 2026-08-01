/**
 * Load per-repo MCP servers from `<repo>/.tacp/mcp.json`.
 *
 * Path policy (lexical only — no realpath/symlink follow):
 * - Absolute command/arg paths are allowed (system/shared tools).
 * - Relative path-like tokens (`./…`, `../…`, `.tacp/…`) resolve from repo root;
 *   rejected if the resolved path escapes outside the repo.
 * - Symlinks are not resolved; containment is string-based after `path.resolve`.
 * - npm package specs (`@scope/pkg`), flags (`-y`, `--flag=…`), and URL schemes
 *   are left unchanged. Write repo-relative scripts as `./path` or `.tacp/…`.
 * - `~` / `~/…` expands to the process home directory (then treated as absolute).
 * - Built-in server name `tacp` is reserved; repo entries with that name are skipped.
 *
 * Optional topic profiles (`.tacp/config.json` + `.tacp/mcp.profiles.json`):
 * - When `mcpProfile` is set and the named profile exists, repo MCP is filtered
 *   to that allowlist before merge with built-in tacp.
 * - Empty profile list `[]` → no repo MCP (built-in still added).
 * - Missing config, missing profiles file, or unknown profile name → no filter.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import {
  buildTacpMcpServers,
  type BuildTacpMcpServersOptions,
  type TacpMcpServer,
} from "./servers";
import { missingOAuthTokenMessage } from "./oauth-flow";
import {
  bearerForMcp,
  repoKeyForOAuth,
  resolveOAuthStateDir,
} from "./oauth-store";
import { remoteMcpEnabled } from "./remote-mcp";

/** ACP-compatible remote MCP (http/sse) — passed through when present. */
export type TacpMcpRemoteServer = {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};

/** Stdio or remote MCP descriptor for a session (matches ACP McpServer shapes we emit). */
export type SessionMcpServer = TacpMcpServer | TacpMcpRemoteServer;

/** Optional per-repo tacp settings from `<repo>/.tacp/config.json`. */
export type RepoTacpConfig = {
  /** Preferred agent for sessions in this repo (not applied at create yet; reserved). */
  defaultAgent?: string;
  /** Name of an allowlist in `.tacp/mcp.profiles.json`. */
  mcpProfile?: string;
};

/** Map profile name → MCP server names from `<repo>/.tacp/mcp.profiles.json`. */
export type RepoMcpProfiles = Record<string, string[]>;

export type LoadRepoMcpServersOptions = {
  log?: Logger;
  /** Override path to mcp.json (tests). Default: `<repoRoot>/.tacp/mcp.json`. */
  configPath?: string;
};

export type LoadRepoTacpConfigOptions = {
  log?: Logger;
  /** Override path to config.json (tests). Default: `<repoRoot>/.tacp/config.json`. */
  configPath?: string;
};

export type LoadRepoMcpProfilesOptions = {
  log?: Logger;
  /** Override path to mcp.profiles.json (tests). */
  profilesPath?: string;
};

export type BuildSessionMcpServersOptions = BuildTacpMcpServersOptions & {
  /** Absolute (or resolvable) repo root / session cwd. */
  cwd: string;
  log?: Logger;
  /** Override path to mcp.json (tests). */
  configPath?: string;
  /** Override path to config.json (tests). */
  repoConfigPath?: string;
  /** Override path to mcp.profiles.json (tests). */
  profilesPath?: string;
  /**
   * Override profile name (tests / future per-session selection).
   * When undefined, uses `mcpProfile` from `.tacp/config.json` if present.
   */
  mcpProfile?: string;
  /**
   * OAuth token store root (`TACP_STATE_DIR`). When set (or defaulted from
   * env), remote http/sse entries get `Authorization: Bearer` from the store.
   */
  oauthStateDir?: string;
  /** Configured repo key for token path (`by-repo/<repoKey>/<id>.json`). */
  repoKey?: string;
  /**
   * When true, remote http/sse without a stored token throw
   * `run /mcp auth <id>`. Default: true when `TACP_OAUTH_CALLBACK_BASE` is set,
   * otherwise false (public remotes still work).
   */
  oauthFailClosed?: boolean;
  /**
   * When false, drop remote http/sse entries and skip OAuth token attach.
   * Default: `TACP_REMOTE_MCP=1` (otherwise off). Local stdio + built-in tacp stay.
   */
  remoteMcpEnabled?: boolean;
};

/** Reserved built-in host MCP name (speak). */
export const TACP_BUILTIN_MCP_NAME = "tacp";

/**
 * True when token should be treated as a filesystem path for repo resolution.
 *
 * Path-like:
 * - absolute (`/…`, and Windows drive if present)
 * - relative with explicit path prefix: `./…`, `../…`, or leading `.` (e.g. `.tacp/…`)
 * - home-relative: `~`, `~/…`
 *
 * Not path-like (left unchanged):
 * - bare binaries (`bun`, `npx`)
 * - npm scoped packages (`@scope/pkg`)
 * - flags (`-y`, `--flag`, `--flag=value`)
 * - URL / scheme tokens (`https://…`)
 */
export function isPathLikeToken(token: string): boolean {
  if (!token) return false;
  // npm scoped package — never a filesystem path
  if (token.startsWith("@")) return false;
  // CLI flags (including --flag=./path forms) — do not rewrite
  if (token.startsWith("-")) return false;
  // URL / scheme (https:, file:, …) — not a repo-relative path
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(token)) return false;

  if (token.startsWith("/") || token.startsWith("\\")) return true;
  if (token.startsWith("./") || token.startsWith("../")) return true;
  // `.tacp/tools/server.ts`, `.` — leading-dot relative paths
  if (token.startsWith(".")) return true;
  // home-relative
  if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) {
    return true;
  }
  return false;
}

/**
 * Lexical containment only (no realpath / symlink follow).
 * Whether `candidate` lies inside `repoRoot` after `path.resolve` (inclusive).
 */
export function isWithinRepo(repoRoot: string, candidate: string): boolean {
  const root = resolve(repoRoot);
  const abs = resolve(candidate);
  if (abs === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(prefix);
}

/** Expand `~` / `~/…` to an absolute path under the process home directory. */
export function expandHomeToken(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/") || token.startsWith("~\\")) {
    return resolve(homedir(), token.slice(2));
  }
  return token;
}

/**
 * Resolve a path-like token against repo root.
 * - Non-path-like tokens (binaries, `@scope/pkg`, flags, URLs) returned unchanged.
 * - `~` expanded via `os.homedir()`, then treated as absolute.
 * - Absolute paths are normalized and allowed (system tools / shared scripts).
 * - Relative paths resolve from repo root; throws if result escapes outside the repo
 *   (blocks `..` escapes). Containment is lexical only — see module docs.
 */
export function resolveRepoPathToken(repoRoot: string, token: string): string {
  if (!isPathLikeToken(token)) return token;

  const root = resolve(repoRoot);
  let candidate = token;
  if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = expandHomeToken(candidate);
  }

  if (isAbsolute(candidate)) {
    return resolve(normalize(candidate));
  }

  const abs = resolve(root, candidate);
  if (!isWithinRepo(root, abs)) {
    throw new Error(
      `path escapes repo root: ${token} → ${abs} (repo: ${root})`,
    );
  }
  return abs;
}

function envObjectToArray(
  env: unknown,
): Array<{ name: string; value: string }> {
  if (env == null) return [];
  if (Array.isArray(env)) {
    const out: Array<{ name: string; value: string }> = [];
    for (const entry of env) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.name === "string" && typeof rec.value === "string") {
        out.push({ name: rec.name, value: rec.value });
      }
    }
    return out;
  }
  if (typeof env === "object") {
    const out: Array<{ name: string; value: string }> = [];
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === "string") {
        out.push({ name, value });
      } else if (value != null) {
        out.push({ name, value: String(value) });
      }
    }
    return out;
  }
  return [];
}

function headersToArray(
  headers: unknown,
): Array<{ name: string; value: string }> {
  if (headers == null) return [];
  if (Array.isArray(headers)) {
    return envObjectToArray(headers);
  }
  if (typeof headers === "object") {
    return envObjectToArray(headers);
  }
  return [];
}

function parseOneServer(
  raw: unknown,
  repoRoot: string,
  index: number,
  log: Logger,
  seenNames: Set<string>,
): SessionMcpServer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    log.warn("repo mcp: skip non-object server entry", { index });
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) {
    log.warn("repo mcp: skip server without name", { index });
    return undefined;
  }

  if (name === TACP_BUILTIN_MCP_NAME) {
    log.warn("repo mcp: skip server; name is reserved for built-in tacp", {
      index,
      name,
    });
    return undefined;
  }

  if (seenNames.has(name)) {
    log.warn("repo mcp: skip duplicate server name", { index, name });
    return undefined;
  }

  const typeRaw =
    typeof rec.type === "string" ? rec.type.trim().toLowerCase() : undefined;

  if (typeRaw === "http" || typeRaw === "sse") {
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!url) {
      log.warn("repo mcp: skip remote server without url", { index, name });
      return undefined;
    }
    seenNames.add(name);
    return {
      type: typeRaw,
      name,
      url,
      headers: headersToArray(rec.headers),
    };
  }

  // stdio (default): command + optional args/env
  if (typeRaw != null && typeRaw !== "stdio") {
    log.warn("repo mcp: skip unsupported server type", {
      index,
      name,
      type: typeRaw,
    });
    return undefined;
  }

  const commandRaw = typeof rec.command === "string" ? rec.command.trim() : "";
  if (!commandRaw) {
    log.warn("repo mcp: skip stdio server without command", { index, name });
    return undefined;
  }

  try {
    const command = resolveRepoPathToken(repoRoot, commandRaw);
    const argsRaw = Array.isArray(rec.args) ? rec.args : [];
    const args: string[] = [];
    for (const a of argsRaw) {
      if (typeof a !== "string") {
        throw new Error(`non-string arg in server ${name}`);
      }
      args.push(resolveRepoPathToken(repoRoot, a));
    }
    seenNames.add(name);
    return {
      name,
      command,
      args,
      env: envObjectToArray(rec.env),
    };
  } catch (err) {
    log.warn("repo mcp: reject server (path safety)", {
      index,
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Read a UTF-8 file; returns undefined on ENOENT or other I/O errors (warns on non-ENOENT). */
async function readOptionalText(
  path: string,
  log: Logger,
  label: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return undefined;
    log.warn(`repo mcp: failed to read ${label}`, {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Read `<repoRoot>/.tacp/config.json`.
 * Missing / invalid → `{}`. Surfaced fields: `defaultAgent`, `mcpProfile`.
 * `defaultAgent` is reserved for future session create; callers may read it now.
 */
export async function loadRepoTacpConfig(
  repoRoot: string,
  options: LoadRepoTacpConfigOptions = {},
): Promise<RepoTacpConfig> {
  const log = options.log ?? silentLogger();
  const root = resolve(repoRoot);
  const configPath =
    options.configPath ?? join(root, ".tacp", "config.json");

  const text = await readOptionalText(configPath, log, "config.json");
  if (text === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    log.warn("repo mcp: invalid JSON in config.json; ignoring", {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("repo mcp: config.json root must be an object", { configPath });
    return {};
  }

  const rec = parsed as Record<string, unknown>;
  const out: RepoTacpConfig = {};
  if (typeof rec.defaultAgent === "string" && rec.defaultAgent.trim()) {
    out.defaultAgent = rec.defaultAgent.trim();
  }
  if (typeof rec.mcpProfile === "string" && rec.mcpProfile.trim()) {
    out.mcpProfile = rec.mcpProfile.trim();
  }
  return out;
}

/**
 * Read `<repoRoot>/.tacp/mcp.profiles.json`.
 * Missing file → undefined (no filtering).
 * Invalid JSON / non-object → warn + undefined.
 * Values must be string arrays of MCP server names; other entries skipped.
 */
export async function loadRepoMcpProfiles(
  repoRoot: string,
  options: LoadRepoMcpProfilesOptions = {},
): Promise<RepoMcpProfiles | undefined> {
  const log = options.log ?? silentLogger();
  const root = resolve(repoRoot);
  const profilesPath =
    options.profilesPath ?? join(root, ".tacp", "mcp.profiles.json");

  const text = await readOptionalText(profilesPath, log, "mcp.profiles.json");
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    log.warn("repo mcp: invalid JSON in mcp.profiles.json; no profile filter", {
      profilesPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("repo mcp: mcp.profiles.json root must be an object", {
      profilesPath,
    });
    return undefined;
  }

  const out: RepoMcpProfiles = {};
  for (const [name, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const key = name.trim();
    if (!key) continue;
    if (!Array.isArray(value)) {
      log.warn("repo mcp: profile value must be an array of server names", {
        profile: key,
      });
      continue;
    }
    const names: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) {
        names.push(entry.trim());
      }
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      log.warn("repo mcp: duplicate profile key after trim; later wins", {
        profile: key,
      });
    }
    out[key] = names;
  }
  return out;
}

/**
 * Filter repo MCP servers by profile allowlist.
 *
 * - No profile name, no profiles map, or unknown profile name → no filter (all).
 * - Known profile with `[]` → empty list (no repo MCP).
 * - Known profile with names → only servers whose name is in the allowlist.
 *   Names listed but absent from mcp.json are ignored.
 *
 * When `log` is provided and `profileName` is set, fail-open paths emit a warn
 * (missing profiles map or unknown key) so typos are not silent.
 */
export function filterRepoMcpByProfile(
  servers: SessionMcpServer[],
  profileName: string | undefined,
  profiles: RepoMcpProfiles | undefined,
  log?: Logger,
): SessionMcpServer[] {
  if (!profileName) return servers;
  if (!profiles) {
    log?.warn(
      "repo mcp: mcpProfile set but profiles unavailable; no filter (all repo MCP)",
      { profileName },
    );
    return servers;
  }
  if (!Object.prototype.hasOwnProperty.call(profiles, profileName)) {
    log?.warn("repo mcp: unknown mcpProfile; no filter (all repo MCP)", {
      profileName,
      available: Object.keys(profiles),
    });
    return servers;
  }
  const allow = profiles[profileName]!;
  if (allow.length === 0) return [];
  const allowed = new Set(allow);
  return servers.filter((s) => allowed.has(s.name));
}

/**
 * Read `<repoRoot>/.tacp/mcp.json` and return parsed servers.
 * Missing file → []; invalid JSON → warn + [].
 * Name `tacp` is reserved; duplicate names within the file are skipped with warn.
 */
export async function loadRepoMcpServers(
  repoRoot: string,
  options: LoadRepoMcpServersOptions = {},
): Promise<SessionMcpServer[]> {
  const log = options.log ?? silentLogger();
  const root = resolve(repoRoot);
  const configPath =
    options.configPath ?? join(root, ".tacp", "mcp.json");

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return [];
    log.warn("repo mcp: failed to read mcp.json", {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    log.warn("repo mcp: invalid JSON in mcp.json; using built-in only", {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("repo mcp: mcp.json root must be an object", { configPath });
    return [];
  }

  const list = (parsed as { mcpServers?: unknown }).mcpServers;
  if (list == null) return [];
  if (!Array.isArray(list)) {
    log.warn("repo mcp: mcpServers must be an array", { configPath });
    return [];
  }

  const seenNames = new Set<string>();
  const out: SessionMcpServer[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = parseOneServer(list[i], root, i, log, seenNames);
    if (s) out.push(s);
  }
  return out;
}

/** Stdio when type is absent/undefined/"stdio", or when command is present without remote type. */
export function isStdioServer(s: SessionMcpServer): s is TacpMcpServer {
  const t = (s as { type?: string }).type;
  if (t === "http" || t === "sse" || t === "acp") return false;
  // absent, undefined, or explicit "stdio"
  return "command" in s && typeof (s as TacpMcpServer).command === "string";
}

/** Inject session/repo identity into stdio MCP child env. */
export function injectSessionEnv(
  server: SessionMcpServer,
  input: {
    sessionKey?: string;
    repoRoot: string;
    /** Per-repo state dir (`<cwd>/.tacp`). */
    repoStateDir: string;
  },
): SessionMcpServer {
  if (!isStdioServer(server)) return server;

  const envMap = new Map(server.env.map((e) => [e.name, e.value]));
  if (input.sessionKey) {
    envMap.set("TACP_SESSION_KEY", input.sessionKey);
  }
  envMap.set("TACP_REPO_ROOT", resolve(input.repoRoot));
  // Per-repo `.tacp` tree (schedules, mcp.json, …) — not the host TACP_STATE_DIR.
  envMap.set("TACP_REPO_STATE_DIR", resolve(input.repoStateDir));

  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: [...envMap.entries()].map(([name, value]) => ({ name, value })),
  };
}

/**
 * Attach OAuth Bearer tokens from the host token store onto remote http/sse
 * MCP entries. Never reads or writes the git repo for tokens.
 *
 * @throws when failClosed and a remote has no stored token
 */
export async function applyOAuthTokensToServers(
  servers: SessionMcpServer[],
  input: {
    stateDir: string;
    repoKey: string;
    failClosed?: boolean;
    log?: Logger;
  },
): Promise<SessionMcpServer[]> {
  const log = input.log ?? silentLogger();
  const out: SessionMcpServer[] = [];

  for (const s of servers) {
    const type = (s as { type?: string }).type;
    if (type !== "http" && type !== "sse") {
      out.push(s);
      continue;
    }
    const remote = s as TacpMcpRemoteServer;
    const auth = await bearerForMcp(input.stateDir, input.repoKey, remote.name);
    if (!auth) {
      if (input.failClosed) {
        throw new Error(missingOAuthTokenMessage(remote.name));
      }
      out.push(remote);
      continue;
    }
    if (auth.expired) {
      log.warn("mcp oauth token expired; using anyway (no refresh in MVP)", {
        id: remote.name,
        repoKey: input.repoKey,
      });
    }
    // Merge Authorization; prefer stored token over any accidental header.
    const headers = remote.headers.filter(
      (h) => h.name.toLowerCase() !== "authorization",
    );
    headers.push({ name: "Authorization", value: auth.value });
    out.push({
      type: remote.type,
      name: remote.name,
      url: remote.url,
      headers,
    });
  }
  return out;
}

function oauthFailClosedDefault(
  explicit: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (explicit !== undefined) return explicit;
  // When OAuth callback infra is configured, require tokens for remotes.
  return Boolean(env.TACP_OAUTH_CALLBACK_BASE?.trim());
}

/**
 * Merge order: **repo MCP first** (optionally profile-filtered), then **built-in tacp** (speak).
 * Missing/invalid repo config → built-in only.
 * Injects TACP_SESSION_KEY / TACP_REPO_ROOT / TACP_REPO_STATE_DIR into every stdio child.
 * Merges OAuth Bearer headers for remote http/sse from the host token store.
 *
 * Profile filter (when `.tacp/config.json` has `mcpProfile` and profiles file exists):
 * see `filterRepoMcpByProfile`. Built-in `tacp` is never filtered out.
 *
 * Returns ACP `McpServer[]` (stdio + optional http/sse).
 */
export async function buildSessionMcpServers(
  options: BuildSessionMcpServersOptions,
): Promise<McpServer[]> {
  const enabled =
    options.enabled ??
    (process.env.TACP_MCP !== "0" && process.env.TACP_MCP !== "false");
  if (!enabled) return [];

  const repoRoot = resolve(options.cwd);
  const repoStateDir = join(repoRoot, ".tacp");
  const log = options.log ?? silentLogger();

  const [repoRaw, repoConfig, profiles] = await Promise.all([
    loadRepoMcpServers(repoRoot, {
      log,
      ...(options.configPath !== undefined
        ? { configPath: options.configPath }
        : {}),
    }),
    loadRepoTacpConfig(repoRoot, {
      log,
      ...(options.repoConfigPath !== undefined
        ? { configPath: options.repoConfigPath }
        : {}),
    }),
    loadRepoMcpProfiles(repoRoot, {
      log,
      ...(options.profilesPath !== undefined
        ? { profilesPath: options.profilesPath }
        : {}),
    }),
  ]);

  const profileName = options.mcpProfile ?? repoConfig.mcpProfile;
  let repo = filterRepoMcpByProfile(repoRaw, profileName, profiles, log);

  const allowRemote = remoteMcpEnabled(process.env, options.remoteMcpEnabled);
  if (!allowRemote) {
    const before = repo.length;
    repo = repo.filter((s) => {
      const t = (s as { type?: string }).type;
      return t !== "http" && t !== "sse";
    });
    if (before > repo.length) {
      log.info("remote MCP skipped (TACP_REMOTE_MCP not enabled)", {
        dropped: before - repo.length,
      });
    }
  }

  const tacp = buildTacpMcpServers({
    enabled: true,
    ...(options.serverEntry !== undefined
      ? { serverEntry: options.serverEntry }
      : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.sessionKey !== undefined
      ? { sessionKey: options.sessionKey }
      : {}),
    ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
  });

  const injectCtx: {
    sessionKey?: string;
    repoRoot: string;
    repoStateDir: string;
  } = {
    repoRoot,
    repoStateDir,
  };
  if (options.sessionKey !== undefined) {
    injectCtx.sessionKey = options.sessionKey;
  }

  let merged: SessionMcpServer[] = [
    ...repo.map((s) => injectSessionEnv(s, injectCtx)),
    ...tacp.map((s) => injectSessionEnv(s, injectCtx)),
  ];

  // OAuth only when remote MCP is enabled.
  if (allowRemote) {
    const oauthStateDir = resolveOAuthStateDir(
      options.oauthStateDir?.trim() || options.stateDir?.trim() || undefined,
    );
    const repoKey = repoKeyForOAuth(options.repoKey, repoRoot);
    const failClosed = oauthFailClosedDefault(options.oauthFailClosed);
    merged = await applyOAuthTokensToServers(merged, {
      stateDir: oauthStateDir,
      repoKey,
      failClosed,
      log,
    });
  }

  // SessionMcpServer is a structural subset of ACP McpServer (stdio | http | sse).
  return merged as McpServer[];
}

// ── Registry read/write (id + url only for remotes; never tokens) ────────────

/** On-disk shape of `<repo>/.tacp/mcp.json` (raw entries preserved for stdio). */
export type McpConfigFile = {
  mcpServers: Array<Record<string, unknown>>;
};

export type McpConfigPathOptions = {
  /** Override path to mcp.json (tests). Default: `<repoRoot>/.tacp/mcp.json`. */
  configPath?: string;
};

export type RemoteMcpWriteInput = {
  name: string;
  url: string;
  /** Default `"http"`. */
  type?: "http" | "sse";
};

/** Default path: `<repoRoot>/.tacp/mcp.json`. */
export function mcpConfigPath(
  repoRoot: string,
  options: McpConfigPathOptions = {},
): string {
  if (options.configPath) return options.configPath;
  return join(resolve(repoRoot), ".tacp", "mcp.json");
}

/**
 * Read raw mcp.json for registry edits.
 * Missing file → `{ mcpServers: [] }`. Invalid JSON / shape → throws.
 */
export async function readMcpConfig(
  repoRoot: string,
  options: McpConfigPathOptions = {},
): Promise<McpConfigFile> {
  const configPath = mcpConfigPath(repoRoot, options);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return { mcpServers: [] };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(
      `invalid JSON in mcp.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mcp.json root must be an object");
  }

  const list = (parsed as { mcpServers?: unknown }).mcpServers;
  if (list == null) return { mcpServers: [] };
  if (!Array.isArray(list)) {
    throw new Error("mcpServers must be an array");
  }

  const mcpServers: Array<Record<string, unknown>> = [];
  for (const entry of list) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      mcpServers.push({ ...(entry as Record<string, unknown>) });
    }
  }
  return { mcpServers };
}

/**
 * Atomic write of mcp.json (temp file + rename).
 * Single-writer assumption (one operator / sequential topic commands); concurrent
 * RMW on the same repo can last-write-win.
 */
export async function writeMcpConfig(
  repoRoot: string,
  config: McpConfigFile,
  options: McpConfigPathOptions = {},
): Promise<void> {
  const configPath = mcpConfigPath(repoRoot, options);
  await mkdir(dirname(configPath), { recursive: true });
  const payload = `${JSON.stringify({ mcpServers: config.mcpServers }, null, 2)}\n`;
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, configPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateRemoteName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error("MCP id is required");
  if (n === TACP_BUILTIN_MCP_NAME) {
    throw new Error(`MCP id "${TACP_BUILTIN_MCP_NAME}" is reserved`);
  }
  if (!REMOTE_NAME_RE.test(n)) {
    throw new Error(
      `invalid MCP id "${n}" (use letters, digits, . _ -; start with alphanumeric)`,
    );
  }
  return n;
}

/**
 * Validate remote MCP URL. Rejects credentials in userinfo (`user:pass@`) so
 * secrets cannot land in git-tracked mcp.json via the URL string.
 */
function validateRemoteUrl(url: string): string {
  const u = url.trim();
  if (!u) throw new Error("MCP url is required");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`invalid MCP url: ${u}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`MCP url must be http(s): ${u}`);
  }
  // Fail closed: userinfo is a common secret channel (Basic auth / API tokens).
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      "MCP url must not include credentials (user:pass@); tokens are never stored in the repo",
    );
  }
  return u;
}

/** True when an existing entry looks like stdio (command, no remote url type). */
function isStdioConfigEntry(s: Record<string, unknown>): boolean {
  const typeRaw =
    typeof s.type === "string" ? s.type.trim().toLowerCase() : undefined;
  if (typeRaw === "http" || typeRaw === "sse") return false;
  return typeof s.command === "string" && s.command.trim() !== "";
}

/**
 * Add or replace a remote (http/sse) MCP entry. Writes **only** `name`, `type`, `url`
 * — never tokens, headers, env, or other secret fields.
 *
 * Same-id replace overwrites an existing **remote** entry. Refuses to clobber a
 * **stdio** entry (command/args/env) — remove it first.
 */
export async function writeRemoteMcpServer(
  repoRoot: string,
  entry: RemoteMcpWriteInput,
  options: McpConfigPathOptions = {},
): Promise<{ name: string; type: "http" | "sse"; url: string }> {
  const name = validateRemoteName(entry.name);
  const url = validateRemoteUrl(entry.url);
  const type: "http" | "sse" = entry.type === "sse" ? "sse" : "http";

  // Intentionally only these three keys — no headers/tokens/env.
  const clean: { name: string; type: "http" | "sse"; url: string } = {
    name,
    type,
    url,
  };

  const config = await readMcpConfig(repoRoot, options);
  const idx = config.mcpServers.findIndex(
    (s) => typeof s.name === "string" && s.name.trim() === name,
  );
  if (idx >= 0) {
    const existing = config.mcpServers[idx]!;
    if (isStdioConfigEntry(existing)) {
      throw new Error(
        `MCP id "${name}" is already a stdio server; run /mcp remove ${name} first before adding a remote URL`,
      );
    }
    config.mcpServers[idx] = { ...clean };
  } else {
    config.mcpServers.push({ ...clean });
  }
  await writeMcpConfig(repoRoot, config, options);
  return clean;
}

/**
 * Remove a server entry by name from mcp.json.
 * @returns true if an entry was removed.
 */
export async function removeMcpServer(
  repoRoot: string,
  name: string,
  options: McpConfigPathOptions = {},
): Promise<boolean> {
  const id = name.trim();
  if (!id) throw new Error("MCP id is required");

  const config = await readMcpConfig(repoRoot, options);
  const before = config.mcpServers.length;
  config.mcpServers = config.mcpServers.filter(
    (s) => !(typeof s.name === "string" && s.name.trim() === id),
  );
  if (config.mcpServers.length === before) return false;
  await writeMcpConfig(repoRoot, config, options);
  return true;
}

/** Human-readable status for `/mcp` / `/mcp status`. */
export function formatMcpRegistryStatus(
  config: McpConfigFile,
  repoRoot?: string,
  auth?: {
    tokenIds?: string[];
    /**
     * When true (TACP_OAUTH_CALLBACK_BASE set), show auth ok/missing for remotes.
     * When false/omitted, omit auth notes (public remotes without OAuth infra).
     */
    oauthEnabled?: boolean;
  },
): string {
  const rootNote = repoRoot ? `\nRepo: \`${resolve(repoRoot)}\`` : "";
  const tokenSet = new Set(auth?.tokenIds ?? []);
  const showAuth = auth?.oauthEnabled === true;
  if (config.mcpServers.length === 0) {
    return (
      `No MCP servers in \`.tacp/mcp.json\`.${rootNote}\n\n` +
      `Add a remote gateway:\n\`/mcp add <id> <url>\``
    );
  }

  const lines = config.mcpServers.map((s) => {
    const name = typeof s.name === "string" ? s.name : "?";
    if (typeof s.url === "string") {
      const type =
        typeof s.type === "string" && s.type.trim()
          ? s.type.trim()
          : "http";
      let authNote = "";
      if (showAuth) {
        authNote = tokenSet.has(name)
          ? " · auth: ok"
          : " · auth: missing (run `/mcp auth " + name + "`)";
      }
      return `• **${name}** (${type}) ${s.url}${authNote}`;
    }
    if (typeof s.command === "string") {
      return `• **${name}** (stdio) \`${s.command}\``;
    }
    return `• **${name}**`;
  });

  return (
    `MCP gateways for this repo (${config.mcpServers.length}):${rootNote}\n\n` +
    lines.join("\n") +
    `\n\n\`/mcp add <id> <url>\` · \`/mcp remove <id>\` · \`/mcp auth <id>\``
  );
}

export const MCP_COMMAND_USAGE =
  "Usage:\n" +
  "`/mcp` or `/mcp status` — list gateways + OAuth status\n" +
  "`/mcp add <id> <url>` — register remote http MCP (id + url only)\n" +
  "`/mcp remove <id>` — remove entry\n" +
  "`/mcp auth <id>` — start OAuth (Telegram link; tokens on host)\n" +
  "`/mcp code <callback-url-or-code> [id]` — paste fallback if redirect cannot reach host\n\n" +
  "Tokens are never written to the repo (no user:pass@ in URLs).\n" +
  "Same id replaces an existing remote entry; stdio entries require `/mcp remove` first.";

