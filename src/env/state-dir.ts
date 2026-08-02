/**
 * Shared runtime state directory (sockets, ACP sessions, OAuth).
 * Prefer TOML `state_dir` (default `~/.local/share/acpbot/state`).
 * Legacy env: `ACPBOT_STATE_DIR` / `TACP_STATE_DIR`.
 */
import { resolve } from "node:path";

/** Last-resort relative path when nothing else is set (tests / odd boots). */
export const DEFAULT_STATE_DIR = "./data/acpbot-state";

/**
 * Raw path from env, or undefined if unset.
 * Does not resolve to absolute.
 */
export function stateDirFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  const v = env.ACPBOT_STATE_DIR?.trim() || env.TACP_STATE_DIR?.trim();
  return v || undefined;
}

/**
 * Absolute state dir: explicit path, else env, else default.
 */
export function resolveStateDir(
  explicit?: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const raw =
    explicit?.trim() || stateDirFromEnv(env) || DEFAULT_STATE_DIR;
  return resolve(raw);
}
