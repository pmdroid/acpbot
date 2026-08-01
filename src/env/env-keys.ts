/**
 * Environment key helpers — prefer ACPBOT_*, accept TACP_* legacy aliases.
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
  return envFirst(env, "ACPBOT_STATE_DIR", "TACP_STATE_DIR");
}

export function defaultAgentEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_DEFAULT_AGENT", "TACP_DEFAULT_AGENT");
}

export function logLevelEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_LOG_LEVEL", "TACP_LOG_LEVEL");
}

export function oauthCallbackBaseEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_OAUTH_CALLBACK_BASE", "TACP_OAUTH_CALLBACK_BASE");
}

export function reposJsonEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return envFirst(env, "ACPBOT_REPOS_JSON", "TACP_REPOS_JSON");
}

/** Per-repo config directory name preference. */
export const REPO_CONFIG_DIR_PREFERRED = ".acpbot";
export const REPO_CONFIG_DIR_LEGACY = ".tacp";
