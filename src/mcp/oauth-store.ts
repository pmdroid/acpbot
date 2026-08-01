/**
 * MCP OAuth token + pending PKCE store.
 *
 * Layout (under absolute `$TACP_STATE_DIR` — same path for worker + acp-host):
 *   mcp-oauth/by-repo/<repoKey>/<id>.json   — access/refresh tokens (mode 0600)
 *   mcp-oauth/pending/<state>.json         — in-flight PKCE (mode 0600, TTL 15m)
 *
 * Tokens must never be written into `<repo>/.tacp/mcp.json` (or any `.tacp` path).
 * Prefer a private state directory (owner-only). Default `data/` is gitignored;
 * avoid placing state under a tracked tree if you can use an absolute path outside the repo.
 */
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveStateDir } from "../env/state-dir";

/** Pending PKCE lifetime (code_verifier retention). */
export const PENDING_OAUTH_TTL_MS = 15 * 60 * 1000;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export type McpOAuthTokenRecord = {
  id: string;
  repoKey: string;
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  /** OAuth resource indicator (RFC 8707) used at authorize/token. */
  resourceUrl?: string;
  /** Original MCP gateway URL from mcp.json. */
  mcpUrl?: string;
  /** Public client_id from dynamic registration. */
  clientId?: string;
  /** Authorization server issuer. */
  authorizationServer?: string;
  createdAt: number;
  updatedAt: number;
};

export type McpOAuthPendingRecord = {
  state: string;
  codeVerifier: string;
  id: string;
  repoKey: string;
  /** Absolute repo cwd used when auth started (for display / fallback). */
  repoRoot: string;
  redirectUri: string;
  /** Public client_id from dynamic registration (not env). */
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientSecret?: string;
  scope?: string;
  /** OAuth resource indicator for authorize + token exchange. */
  resourceUrl?: string;
  /** Original MCP gateway URL. */
  mcpUrl?: string;
  authorizationServer?: string;
  createdAt: number;
};

export type OAuthStorePaths = {
  /** Absolute state dir root. */
  stateDir: string;
  root: string;
  byRepo: string;
  pending: string;
};

/**
 * Resolve OAuth / runtime state directory to an **absolute** path.
 * Worker and acp-host must share the same absolute path for pending PKCE + tokens.
 */
export function defaultOAuthStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const oauthOnly = env.TACP_OAUTH_STATE_DIR?.trim();
  if (oauthOnly) return resolve(oauthOnly);
  return resolveStateDir(undefined, env);
}

/**
 * Normalize any stateDir input to absolute (path.resolve).
 * Prefer this at every store entrypoint so relative paths never diverge by CWD.
 */
export function resolveOAuthStateDir(stateDir?: string): string {
  if (stateDir && stateDir.trim()) {
    const s = stateDir.trim();
    return isAbsolute(s) ? s : resolve(s);
  }
  return defaultOAuthStateDir();
}

export function oauthStorePaths(stateDir: string): OAuthStorePaths {
  const abs = resolveOAuthStateDir(stateDir);
  const root = join(abs, "mcp-oauth");
  return {
    stateDir: abs,
    root,
    byRepo: join(root, "by-repo"),
    pending: join(root, "pending"),
  };
}

/**
 * Stable filesystem-safe key for a repo.
 * Prefer the configured repo key (e.g. "demo"); otherwise hash of resolved cwd.
 */
export function repoKeyForOAuth(
  repoKey: string | undefined,
  repoRoot: string,
): string {
  const k = repoKey?.trim();
  if (k && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(k) && k.length <= 64) {
    return k;
  }
  const abs = resolve(repoRoot);
  return createHash("sha256").update(abs).digest("hex").slice(0, 16);
}

function tokenPath(paths: OAuthStorePaths, repoKey: string, id: string): string {
  return join(paths.byRepo, sanitizeSegment(repoKey), `${sanitizeSegment(id)}.json`);
}

function pendingPath(paths: OAuthStorePaths, state: string): string {
  return join(paths.pending, `${sanitizeSegment(state)}.json`);
}

function sanitizeSegment(s: string): string {
  const t = s.trim();
  if (!t) throw new Error("empty path segment");
  // Prevent path traversal in store keys
  if (t.includes("..") || t.includes("/") || t.includes("\\") || t.includes(sep)) {
    throw new Error(`invalid store key segment: ${t}`);
  }
  return t;
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await chmod(dir, DIR_MODE);
  } catch {
    /* best-effort on platforms that ignore mode */
  }
}

async function atomicWrite(filePath: string, payload: string): Promise<void> {
  await ensurePrivateDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, payload, { encoding: "utf8", mode: FILE_MODE });
    await rename(tmp, filePath);
    try {
      await chmod(filePath, FILE_MODE);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Guard: refuse to write OAuth material under `.git` or any `.tacp` path
 * (including mcp.json). Does not forbid a state dir that happens to live
 * under the repo tree outside `.tacp` (e.g. gitignored `data/`) — prefer an
 * absolute private path outside the git worktree when possible.
 *
 * Set `TACP_OAUTH_ALLOW_IN_REPO_STATE=1` is reserved for future tightening;
 * currently paths under repoRoot but outside `.tacp` are allowed.
 */
export function assertNotRepoPath(targetPath: string, repoRoot?: string): void {
  const abs = resolve(targetPath);
  const norm = abs.split(sep).join("/");
  if (norm.includes("/.git/") || norm.endsWith("/.git")) {
    throw new Error(`refusing to write OAuth data under .git: ${abs}`);
  }
  // Never write into <repo>/.tacp/… (mcp.json, mcp-oauth, etc.)
  if (norm.includes("/.tacp/") || /\/\.tacp$/i.test(norm)) {
    throw new Error(
      `refusing to write OAuth tokens under repo .tacp path: ${abs}`,
    );
  }
  if (repoRoot) {
    const root = resolve(repoRoot);
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (
      (abs === root || abs.startsWith(prefix)) &&
      process.env.TACP_OAUTH_ALLOW_IN_REPO_STATE !== "1" &&
      process.env.TACP_OAUTH_ALLOW_IN_REPO_STATE !== "true"
    ) {
      // Soft policy: only refuse if clearly under .tacp (already handled).
      // Document that absolute TACP_STATE_DIR outside the worktree is preferred.
      void 0;
    }
  }
}

export function isPendingExpired(
  record: { createdAt: number },
  now: number = Date.now(),
  ttlMs: number = PENDING_OAUTH_TTL_MS,
): boolean {
  if (!Number.isFinite(record.createdAt) || record.createdAt <= 0) return true;
  return now - record.createdAt > ttlMs;
}

export async function writePendingOAuth(
  stateDir: string,
  record: McpOAuthPendingRecord,
): Promise<string> {
  const paths = oauthStorePaths(stateDir);
  assertNotRepoPath(paths.root, record.repoRoot);
  await ensurePrivateDir(paths.root);
  await ensurePrivateDir(paths.pending);
  const file = pendingPath(paths, record.state);
  assertNotRepoPath(file, record.repoRoot);
  await atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/**
 * Read pending PKCE by state. Returns undefined if missing or **expired**
 * (expired files are deleted).
 */
export async function readPendingOAuth(
  stateDir: string,
  state: string,
  opts?: { now?: number; ttlMs?: number },
): Promise<McpOAuthPendingRecord | undefined> {
  const paths = oauthStorePaths(stateDir);
  const file = pendingPath(paths, state);
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text) as McpOAuthPendingRecord;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.state !== state) return undefined;
    if (isPendingExpired(parsed, opts?.now, opts?.ttlMs)) {
      await unlink(file).catch(() => {});
      return undefined;
    }
    return parsed;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

export async function deletePendingOAuth(
  stateDir: string,
  state: string,
): Promise<boolean> {
  const paths = oauthStorePaths(stateDir);
  const file = pendingPath(paths, state);
  try {
    await unlink(file);
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Delete all pending PKCE records for a gateway id (optional repoKey filter).
 * Used on `/mcp auth` start so only one in-flight flow remains.
 */
export async function deletePendingForGateway(
  stateDir: string,
  id: string,
  repoKey?: string,
): Promise<number> {
  const paths = oauthStorePaths(stateDir);
  let names: string[];
  try {
    names = await readdir(paths.pending);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(paths.pending, name);
    try {
      const text = await readFile(file, "utf8");
      const rec = JSON.parse(text) as McpOAuthPendingRecord;
      if (rec.id !== id) continue;
      if (repoKey && rec.repoKey !== repoKey) continue;
      await unlink(file);
      n++;
    } catch {
      /* skip corrupt */
    }
  }
  return n;
}

/** Remove expired pending files. Returns count deleted. */
export async function pruneExpiredPendingOAuth(
  stateDir: string,
  opts?: { now?: number; ttlMs?: number },
): Promise<number> {
  const paths = oauthStorePaths(stateDir);
  let names: string[];
  try {
    names = await readdir(paths.pending);
  } catch {
    return 0;
  }
  const now = opts?.now ?? Date.now();
  const ttl = opts?.ttlMs ?? PENDING_OAUTH_TTL_MS;
  let n = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(paths.pending, name);
    try {
      const text = await readFile(file, "utf8");
      const rec = JSON.parse(text) as McpOAuthPendingRecord;
      if (isPendingExpired(rec, now, ttl)) {
        await unlink(file);
        n++;
      }
    } catch {
      /* skip */
    }
  }
  return n;
}

export async function writeOAuthToken(
  stateDir: string,
  record: McpOAuthTokenRecord,
  opts?: { repoRoot?: string },
): Promise<string> {
  const paths = oauthStorePaths(stateDir);
  assertNotRepoPath(paths.root, opts?.repoRoot);
  await ensurePrivateDir(paths.root);
  await ensurePrivateDir(paths.byRepo);
  const file = tokenPath(paths, record.repoKey, record.id);
  assertNotRepoPath(file, opts?.repoRoot);
  await atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

export async function readOAuthToken(
  stateDir: string,
  repoKey: string,
  id: string,
): Promise<McpOAuthTokenRecord | undefined> {
  const paths = oauthStorePaths(stateDir);
  const file = tokenPath(paths, repoKey, id);
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text) as McpOAuthTokenRecord;
    if (!parsed?.accessToken) return undefined;
    return parsed;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

export async function deleteOAuthToken(
  stateDir: string,
  repoKey: string,
  id: string,
): Promise<boolean> {
  const paths = oauthStorePaths(stateDir);
  const file = tokenPath(paths, repoKey, id);
  try {
    await unlink(file);
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return false;
    throw err;
  }
}

/** List gateway ids that have tokens for a repoKey. */
export async function listOAuthTokenIds(
  stateDir: string,
  repoKey: string,
): Promise<string[]> {
  const paths = oauthStorePaths(stateDir);
  const dir = join(paths.byRepo, sanitizeSegment(repoKey));
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length));
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Authorization header value for a stored token, or undefined if missing/expired.
 * Expired tokens still return the value (refresh is out of MVP scope) but
 * `expired` is set so callers can warn.
 */
export async function bearerForMcp(
  stateDir: string,
  repoKey: string,
  id: string,
): Promise<{ value: string; expired: boolean; record: McpOAuthTokenRecord } | undefined> {
  const record = await readOAuthToken(stateDir, repoKey, id);
  if (!record) return undefined;
  const expired =
    typeof record.expiresAt === "number" && record.expiresAt <= Date.now();
  const typ = (record.tokenType || "Bearer").trim() || "Bearer";
  // Normalize "bearer" → "Bearer"
  const prefix = typ.toLowerCase() === "bearer" ? "Bearer" : typ;
  return {
    value: `${prefix} ${record.accessToken}`,
    expired,
    record,
  };
}


