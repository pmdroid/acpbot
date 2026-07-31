/**
 * MCP OAuth token + pending PKCE store.
 *
 * Layout (under `$TACP_ACPX_STATE_DIR`, never under a git repo):
 *   mcp-oauth/by-repo/<repoKey>/<id>.json   — access/refresh tokens
 *   mcp-oauth/pending/<state>.json         — in-flight PKCE
 *
 * Tokens must never be written into `<repo>/.tacp/mcp.json`.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type McpOAuthTokenRecord = {
  id: string;
  repoKey: string;
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  /** Resource / MCP URL this token was obtained for. */
  resourceUrl?: string;
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
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientSecret?: string;
  scope?: string;
  resourceUrl?: string;
  createdAt: number;
};

export type OAuthStorePaths = {
  stateDir: string;
  root: string;
  byRepo: string;
  pending: string;
};

/** Default state dir from env (same as acp-host / sessions). */
export function defaultOAuthStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.TACP_ACPX_STATE_DIR?.trim() ||
    env.TACP_OAUTH_STATE_DIR?.trim() ||
    "./data/acpx-state"
  );
}

export function oauthStorePaths(stateDir: string): OAuthStorePaths {
  const root = join(resolve(stateDir), "mcp-oauth");
  return {
    stateDir: resolve(stateDir),
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

async function atomicWrite(filePath: string, payload: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Guard: refuse to write oauth files under a path that looks like a repo's
 * `.tacp` directory or any path containing `/.git/`. Callers pass stateDir only.
 */
export function assertNotRepoPath(targetPath: string, repoRoot?: string): void {
  const abs = resolve(targetPath);
  const norm = abs.split(sep).join("/");
  if (norm.includes("/.git/") || norm.endsWith("/.git")) {
    throw new Error(`refusing to write OAuth data under .git: ${abs}`);
  }
  // Explicitly never write into <repo>/.tacp/mcp-oauth or mcp.json
  if (norm.includes("/.tacp/mcp") || /\/\.tacp\/mcp\.json$/i.test(norm)) {
    throw new Error(
      `refusing to write OAuth tokens into repo .tacp path: ${abs}`,
    );
  }
  if (repoRoot) {
    const root = resolve(repoRoot);
    const prefix = root.endsWith(sep) ? root : root + sep;
    // Allow only if target is outside the repo (state dir is typically outside)
    if (abs === root || abs.startsWith(prefix)) {
      // Exception: if stateDir is intentionally inside repo (dev), still block
      // writing next to mcp.json — require mcp-oauth not under .tacp
      if (norm.includes("/.tacp/")) {
        throw new Error(
          `refusing to store OAuth tokens under repo .tacp (use TACP_ACPX_STATE_DIR): ${abs}`,
        );
      }
    }
  }
}

export async function writePendingOAuth(
  stateDir: string,
  record: McpOAuthPendingRecord,
): Promise<string> {
  const paths = oauthStorePaths(stateDir);
  assertNotRepoPath(paths.root, record.repoRoot);
  const file = pendingPath(paths, record.state);
  assertNotRepoPath(file, record.repoRoot);
  await atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

export async function readPendingOAuth(
  stateDir: string,
  state: string,
): Promise<McpOAuthPendingRecord | undefined> {
  const paths = oauthStorePaths(stateDir);
  const file = pendingPath(paths, state);
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text) as McpOAuthPendingRecord;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.state !== state) return undefined;
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

export async function writeOAuthToken(
  stateDir: string,
  record: McpOAuthTokenRecord,
  opts?: { repoRoot?: string },
): Promise<string> {
  const paths = oauthStorePaths(stateDir);
  assertNotRepoPath(paths.root, opts?.repoRoot);
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

/** Resolve absolute state dir; useful in tests. */
export function resolveStateDir(stateDir?: string): string {
  if (stateDir && stateDir.trim()) {
    const s = stateDir.trim();
    return isAbsolute(s) ? s : resolve(s);
  }
  return resolve(defaultOAuthStateDir());
}
