/**
 * Environment key helpers — `ACPBOT_*` process env names.
 */

export function envFirst(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** State dir raw path from env. */
export function stateDirEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_STATE_DIR");
}

export function defaultAgentEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_DEFAULT_AGENT");
}

export function logLevelEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_LOG_LEVEL");
}

export function oauthCallbackBaseEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_OAUTH_CALLBACK_BASE");
}

export function reposJsonEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_REPOS_JSON");
}

/** Per-repo config directory name. */
export const REPO_CONFIG_DIR_PREFERRED = ".acpbot";
