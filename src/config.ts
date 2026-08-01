import { homedir } from "node:os";
import { join } from "node:path";
import type { LogLevel, TacpConfig } from "./env/types";
import { parseLogLevel } from "./env/logger";
import { resolveStateDir, stateDirFromEnv } from "./env/state-dir";

/**
 * Load configuration from process env / a JSON blob.
 * No assumed filesystem layout: store path and token are explicit config.
 */
export type ProcessConfig = TacpConfig & {
  botToken: string;
  /** Durable tacp store file path — caller chooses location. */
  storePath: string;
  /**
   * Shared runtime state dir (sockets, ACP sessions, OAuth).
   * Env: `TACP_STATE_DIR`.
   */
  stateDir: string;
  verbose?: boolean;
  /** debug | info | warn | error | silent — TACP_LOG_LEVEL (default info; TACP_VERBOSE=1 → debug). */
  logLevel: LogLevel;
};

export type LoadConfigOptions = {
  env?: Record<string, string | undefined>;
  /** Optional pre-parsed JSON config object. */
  file?: Partial<ProcessConfig> & {
    repos?: Record<string, string>;
    logLevel?: LogLevel;
  };
};

/** Map friendly agent names onto registry ids. */
export function normalizeAgentName(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === "grok" || n === "xai" || n === "grok-build") return "grok-build";
  return n;
}

export function loadConfig(options: LoadConfigOptions = {}): ProcessConfig {
  const env = options.env ?? process.env;
  const file = options.file ?? {};

  const botToken = file.botToken ?? env.TACP_BOT_TOKEN ?? env.BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "Missing bot token. Set TACP_BOT_TOKEN (or pass botToken in config).",
    );
  }

  const operatorRaw =
    file.operatorUserId?.toString() ??
    env.TACP_OPERATOR_USER_ID ??
    env.OPERATOR_USER_ID;
  if (!operatorRaw) {
    throw new Error(
      "Missing operator user id. Set TACP_OPERATOR_USER_ID to your Telegram user id.",
    );
  }
  const operatorUserId = Number(operatorRaw);
  if (!Number.isFinite(operatorUserId)) {
    throw new Error(`Invalid operator user id: ${operatorRaw}`);
  }

  const storePath = file.storePath ?? env.TACP_STORE_PATH;
  if (!storePath) {
    throw new Error(
      "Missing store path. Set TACP_STORE_PATH to a writable JSON file path.",
    );
  }

  const stateDirRaw = file.stateDir ?? stateDirFromEnv(env);
  if (!stateDirRaw) {
    throw new Error(
      "Missing state dir. Set TACP_STATE_DIR to a writable directory.",
    );
  }
  // Always absolute so worker + acp-host share OAuth pending/tokens regardless of CWD.
  const stateDir = resolveStateDir(stateDirRaw, env);

  let repos = file.repos;
  if (!repos && env.TACP_REPOS_JSON) {
    let raw = env.TACP_REPOS_JSON.trim();
    // dotenv may leave surrounding quotes depending on the loader.
    if (
      (raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"'))
    ) {
      raw = raw.slice(1, -1);
    }
    repos = JSON.parse(raw) as Record<string, string>;
  }

  const operatorChatIdRaw =
    file.operatorChatId?.toString() ?? env.TACP_OPERATOR_CHAT_ID;
  const operatorChatId = operatorChatIdRaw
    ? Number(operatorChatIdRaw)
    : undefined;

  const config: ProcessConfig = {
    botToken,
    storePath,
    stateDir,
    operatorUserId,
    defaultAgent: normalizeAgentName(
      file.defaultAgent ?? env.TACP_DEFAULT_AGENT ?? "grok-build",
    ),
    logLevel: "info",
  };
  if (operatorChatId !== undefined && Number.isFinite(operatorChatId)) {
    config.operatorChatId = operatorChatId;
  }
  if (repos) config.repos = repos;
  const verbose = file.verbose === true || env.TACP_VERBOSE === "1";
  if (verbose) config.verbose = true;
  config.logLevel = parseLogLevel(
    file.logLevel ?? env.TACP_LOG_LEVEL,
    verbose,
  );

  // Skill discovery roots (absolute). Session cwd subdirs are added at list time.
  const skillRoots: string[] = [];
  // Always include package-bundled skills (telegram, schedules, …).
  skillRoots.push(join(import.meta.dir, "..", "skills"));
  if (file.skillRoots) skillRoots.push(...file.skillRoots);
  if (env.TACP_SKILL_ROOTS) {
    for (const part of env.TACP_SKILL_ROOTS.split(/[:;,]/)) {
      const p = part.trim();
      if (p) skillRoots.push(p);
    }
  }
  // Sensible defaults for Grok / agents CLIs when HOME is known (config layer only).
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (home) {
    for (const rel of [
      ".grok/skills",
      ".grok/bundled/skills",
      ".agents/skills",
      ".claude/skills",
    ]) {
      skillRoots.push(join(home, rel));
    }
  }
  if (skillRoots.length > 0) {
    config.skillRoots = [...new Set(skillRoots)];
  }

  // Opt-in: ACP image/audio blocks (needs agent promptCapabilities.image).
  if (
    file.acpMediaAttachments === true ||
    env.TACP_ACP_MEDIA_ATTACHMENTS === "1" ||
    env.TACP_ACP_MEDIA_ATTACHMENTS === "true"
  ) {
    config.acpMediaAttachments = true;
  }

  // TTS: agent-controlled by default (not every reply).
  const ttsModeRaw = (
    file.ttsMode ??
    env.TACP_TTS_MODE ??
    // Legacy: TACP_TTS=0 means off; =1 alone no longer means always.
    (env.TACP_TTS === "0" || env.TACP_TTS === "false" ? "off" : undefined)
  ) as string | undefined;
  if (ttsModeRaw !== undefined) {
    const n = ttsModeRaw.trim().toLowerCase();
    if (n === "off" || n === "0" || n === "false" || n === "never") {
      config.ttsMode = "off";
    } else if (n === "always" || n === "on" || n === "true") {
      config.ttsMode = "always";
    } else {
      config.ttsMode = "agent";
    }
  } else {
    config.ttsMode = "agent";
  }

  // Host MCP tools for the agent (speak via FastMCP; STT later). Default on.
  if (
    file.mcpEnabled === false ||
    env.TACP_MCP === "0" ||
    env.TACP_MCP === "false"
  ) {
    config.mcpEnabled = false;
  } else {
    config.mcpEnabled = true;
  }

  // Remote http/sse MCP + OAuth (optional). Default off.
  const remoteRaw = env.TACP_REMOTE_MCP?.trim().toLowerCase();
  if (file.remoteMcpEnabled === true) {
    config.remoteMcpEnabled = true;
  } else if (file.remoteMcpEnabled === false) {
    config.remoteMcpEnabled = false;
  } else {
    config.remoteMcpEnabled =
      remoteRaw === "1" ||
      remoteRaw === "true" ||
      remoteRaw === "on" ||
      remoteRaw === "yes";
  }

  return config;
}
