/**
 * Resolve and validate agent-supplied paths against a repo root.
 * Rejects escapes outside the repo (including via ..).
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type ResolvedRepoPath =
  | { ok: true; abs: string; rel: string; size: number }
  | { ok: false; error: string };

/**
 * Resolve `userPath` under `repoRoot`. Accepts absolute paths only if they
 * stay inside the repo after realpath.
 */
export function resolvePathUnderRepo(
  repoRoot: string,
  userPath: string,
): ResolvedRepoPath {
  const rootRaw = repoRoot.trim();
  const pathRaw = userPath.trim();
  if (!rootRaw) return { ok: false, error: "repo root is empty" };
  if (!pathRaw) return { ok: false, error: "path is empty" };

  let rootAbs: string;
  try {
    rootAbs = realpathSync(rootRaw);
  } catch {
    rootAbs = resolve(rootRaw);
  }

  const candidate = isAbsolute(pathRaw)
    ? normalize(pathRaw)
    : normalize(join(rootAbs, pathRaw));

  let abs: string;
  try {
    abs = realpathSync(candidate);
  } catch {
    // File may not exist yet for write cases; still enforce containment on resolved path.
    abs = resolve(candidate);
  }

  const rel = relative(rootAbs, abs);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return {
      ok: false,
      error: `path escapes repo root: ${userPath}`,
    };
  }

  let size = 0;
  try {
    const st = statSync(abs);
    if (!st.isFile()) {
      return { ok: false, error: `not a regular file: ${userPath}` };
    }
    size = st.size;
  } catch (err) {
    return {
      ok: false,
      error: `file not found: ${userPath}${
        err instanceof Error ? ` (${err.message})` : ""
      }`,
    };
  }

  return { ok: true, abs, rel: rel || ".", size };
}

/** Telegram Bot API practical limits (bot uploads). */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

const PHOTO_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
]);

export function looksLikeImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return PHOTO_EXT.has(lower.slice(dot));
}

export function basenameOf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "file";
}
