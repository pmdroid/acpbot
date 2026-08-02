/**
 * Per-repo acpbot config directory (mcp.json, schedules, profiles).
 * Always `.acpbot` under the repo root.
 */
import { join, resolve } from "node:path";

export const REPO_CONFIG_DIR_PREFERRED = ".acpbot";

/**
 * Absolute path to the repo's config root (`.acpbot`).
 * Creates the logical path for new writes even if the dir does not exist yet.
 */
export function resolveRepoConfigDir(repoRoot: string): string {
  return join(resolve(repoRoot), REPO_CONFIG_DIR_PREFERRED);
}

/** Basename of the config dir for this repo. */
export function repoConfigDirName(_repoRoot?: string): string {
  return REPO_CONFIG_DIR_PREFERRED;
}

/** True if absolute path is under a repo `.acpbot` config dir. */
export function isUnderRepoConfigDir(absPath: string): boolean {
  const norm = absPath.replace(/\\/g, "/");
  return norm.includes("/.acpbot/") || /\/\.acpbot$/i.test(norm);
}
