/**
 * Shared runtime state directory (sockets, ACP sessions, OAuth).
 * Env: `ACPBOT_STATE_DIR` or `TACP_STATE_DIR` (required for loadConfig).
 */
import { resolve } from "node:path";

/** Default relative path when env is unset (code fallbacks only). */
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
