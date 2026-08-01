/**
 * Per-repo acpbot config directory (mcp.json, schedules, profiles).
 * Prefers `.acpbot`; falls back to legacy `.tacp` when present.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_CONFIG_DIR_PREFERRED = ".acpbot";
export const REPO_CONFIG_DIR_LEGACY = ".tacp";

/**
 * Absolute path to the repo's config root (`.acpbot` or legacy `.tacp`).
 * When neither exists, returns preferred (for new writes).
 */
export function resolveRepoConfigDir(repoRoot: string): string {
  const root = resolve(repoRoot);
  const preferred = join(root, REPO_CONFIG_DIR_PREFERRED);
  const legacy = join(root, REPO_CONFIG_DIR_LEGACY);
  if (existsSync(preferred)) return preferred;
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/** Basename of the active config dir for this repo. */
export function repoConfigDirName(repoRoot: string): string {
  const abs = resolveRepoConfigDir(repoRoot);
  return abs.endsWith(REPO_CONFIG_DIR_LEGACY)
    ? REPO_CONFIG_DIR_LEGACY
    : REPO_CONFIG_DIR_PREFERRED;
}

/** True if absolute path is under a repo config dir (.acpbot or .tacp). */
export function isUnderRepoConfigDir(absPath: string): boolean {
  const norm = absPath.replace(/\\/g, "/");
  return (
    norm.includes("/.acpbot/") ||
    /\/\.acpbot$/i.test(norm) ||
    norm.includes("/.tacp/") ||
    /\/\.tacp$/i.test(norm)
  );
}
