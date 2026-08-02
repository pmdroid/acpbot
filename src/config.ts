/**
 * acpbot configuration — TOML-first with XDG-style defaults.
 *
 * Primary file: `~/.config/acpbot/config.toml` (or `$ACPBOT_CONFIG` / `--config`).
 * Defaults (when omitted in TOML):
 *   store  → `~/.local/share/acpbot/store.json`
 *   state  → `~/.local/share/acpbot/state`
 *
 * Legacy env vars still override individual fields when set (migration / CI),
 * but operators should use the TOML file for launchd/systemd installs.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LogLevel, AcpbotConfig } from "./env/types";
import { parseLogLevel } from "./env/logger";
import { resolveStateDir } from "./env/state-dir";
import {
  parseSpeechProvider,
  type SpeechSettings,
} from "./env/speech";

export type ProcessConfig = AcpbotConfig & {
  botToken: string;
  /** Durable session index JSON. */
  storePath: string;
  /** Shared runtime state (sockets, ACP sessions, OAuth). Always absolute. */
  stateDir: string;
  verbose?: boolean;
  logLevel: LogLevel;
  /** Path the TOML was loaded from (if any). */
  configPath?: string;
  oauthCallbackBase?: string;
  oauthListenHost?: string;
  oauthListenPort?: number;
  scheduleTickMs?: number;
  /** Absolute extra skill roots from config. */
  skillRoots?: string[];
  /** Speech providers (TTS/STT independent; see SpeechSettings). */
  speech?: SpeechSettings;
  agentCommandJson?: string;
  claudeAcpPkg?: string;
  codexAcpPkg?: string;
};

export type LoadConfigOptions = {
  env?: Record<string, string | undefined>;
  /** CLI argv (defaults to process.argv). Used for `--config`. */
  argv?: string[];
  /** Explicit config file path (wins over discovery). */
  configPath?: string;
  /**
   * When false, bot token / operator id are not required (acp-host).
   * Default true (Telegram worker).
   */
  requireTelegram?: boolean;
  /**
   * Pre-parsed object (tests). Snake_case TOML keys or camelCase both accepted
   * via {@link normalizeToml}.
   */
  file?: Record<string, unknown>;
  /** Skip reading disk when true (use file/env only). */
  skipFile?: boolean;
};

/** Map friendly agent names onto registry ids. */
export function normalizeAgentName(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === "grok" || n === "xai" || n === "grok-build") return "grok-build";
  return n;
}

export function homeDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

/** `~/.config/acpbot` or `$XDG_CONFIG_HOME/acpbot`. */
export function defaultConfigDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "acpbot");
  return join(homeDir(env), ".config", "acpbot");
}

/** `~/.local/share/acpbot` or `$XDG_DATA_HOME/acpbot`. */
export function defaultDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "acpbot");
  return join(homeDir(env), ".local", "share", "acpbot");
}

export function defaultConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(defaultConfigDir(env), "config.toml");
}

export function defaultStorePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(defaultDataDir(env), "store.json");
}

export function defaultStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(defaultDataDir(env), "state");
}

/** Parse `--config PATH` or `--config=PATH` from argv. */
export function configPathFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a === "-c") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) return next;
    }
    if (a.startsWith("--config=")) return a.slice("--config=".length) || undefined;
  }
  return undefined;
}

/**
 * Resolve which TOML file to load.
 * Order: explicit → argv → ACPBOT_CONFIG → default path if it exists → cwd config.toml.
 */
export function resolveConfigFilePath(
  options: LoadConfigOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  if (options.configPath?.trim()) return expandHome(options.configPath.trim(), env);
  const fromArgv = configPathFromArgv(options.argv ?? process.argv);
  if (fromArgv) return expandHome(fromArgv, env);
  const fromEnv = env.ACPBOT_CONFIG?.trim() || env.TACP_CONFIG?.trim();
  if (fromEnv) return expandHome(fromEnv, env);
  const def = defaultConfigPath(env);
  if (existsSync(def)) return def;
  const cwdToml = resolve("config.toml");
  if (existsSync(cwdToml)) return cwdToml;
  return undefined;
}

export function expandHome(
  path: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (path === "~") return homeDir(env);
  if (path.startsWith("~/")) return join(homeDir(env), path.slice(2));
  return path;
}

export function resolvePath(
  path: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const expanded = expandHome(path.trim(), env);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Flatten TOML (snake_case + nested tables) into a Partial ProcessConfig shape. */
export function normalizeToml(raw: Record<string, unknown>): Partial<ProcessConfig> & {
  verbose?: boolean;
  sttEnabled?: boolean;
} {
  const out: Record<string, unknown> = {};

  const pick = (camel: string, snake: string) => {
    if (raw[camel] !== undefined) out[camel] = raw[camel];
    else if (raw[snake] !== undefined) out[camel] = raw[snake];
  };

  pick("botToken", "bot_token");
  pick("operatorUserId", "operator_user_id");
  pick("operatorChatId", "operator_chat_id");
  pick("storePath", "store_path");
  pick("stateDir", "state_dir");
  pick("defaultAgent", "default_agent");
  pick("logLevel", "log_level");
  pick("verbose", "verbose");
  pick("skillRoots", "skill_roots");
  pick("acpMediaAttachments", "acp_media_attachments");
  pick("ttsMode", "tts_mode");
  pick("mcpEnabled", "mcp");
  pick("mcpEnabled", "mcp_enabled");
  pick("scheduleTickMs", "schedule_tick_ms");
  pick("agentCommandJson", "agent_command_json");
  pick("claudeAcpPkg", "claude_acp_pkg");
  pick("codexAcpPkg", "codex_acp_pkg");

  if (raw.repos && typeof raw.repos === "object" && !Array.isArray(raw.repos)) {
    out.repos = raw.repos as Record<string, string>;
  }

  const features = raw.features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const f = features as Record<string, unknown>;
    if (f.mcp !== undefined) out.mcpEnabled = f.mcp;
    if (f.mcp_enabled !== undefined) out.mcpEnabled = f.mcp_enabled;
    if (f.tts_mode !== undefined) out.ttsMode = f.tts_mode;
    if (f.ttsMode !== undefined) out.ttsMode = f.ttsMode;
    if (f.acp_media_attachments !== undefined) {
      out.acpMediaAttachments = f.acp_media_attachments;
    }
    if (f.acpMediaAttachments !== undefined) {
      out.acpMediaAttachments = f.acpMediaAttachments;
    }
    if (f.stt !== undefined) out.sttEnabled = f.stt;
    if (f.verbose !== undefined) out.verbose = f.verbose;
  }

  const oauth = raw.oauth;
  if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
    const o = oauth as Record<string, unknown>;
    if (o.callback_base !== undefined) out.oauthCallbackBase = o.callback_base;
    if (o.callbackBase !== undefined) out.oauthCallbackBase = o.callbackBase;
    if (o.listen_host !== undefined) out.oauthListenHost = o.listen_host;
    if (o.listenHost !== undefined) out.oauthListenHost = o.listenHost;
    if (o.listen_port !== undefined) out.oauthListenPort = o.listen_port;
    if (o.listenPort !== undefined) out.oauthListenPort = o.listenPort;
  }
  pick("oauthCallbackBase", "oauth_callback_base");
  pick("oauthListenHost", "oauth_listen_host");
  pick("oauthListenPort", "oauth_listen_port");

  const schedule = raw.schedule;
  if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) {
    const s = schedule as Record<string, unknown>;
    if (s.tick_ms !== undefined) out.scheduleTickMs = s.tick_ms;
    if (s.tickMs !== undefined) out.scheduleTickMs = s.tickMs;
  }

  const skills = raw.skills;
  if (skills && typeof skills === "object" && !Array.isArray(skills)) {
    const s = skills as Record<string, unknown>;
    if (Array.isArray(s.roots)) out.skillRoots = s.roots;
  }

  const speech = raw.speech;
  if (speech && typeof speech === "object" && !Array.isArray(speech)) {
    out.speech = normalizeSpeechToml(speech as Record<string, unknown>);
  }

  const agents = raw.agents;
  if (agents && typeof agents === "object" && !Array.isArray(agents)) {
    const a = agents as Record<string, unknown>;
    if (a.command_json !== undefined) {
      out.agentCommandJson =
        typeof a.command_json === "string"
          ? a.command_json
          : JSON.stringify(a.command_json);
    }
    if (a.claude_acp_pkg !== undefined) out.claudeAcpPkg = String(a.claude_acp_pkg);
    if (a.codex_acp_pkg !== undefined) out.codexAcpPkg = String(a.codex_acp_pkg);
  }

  return out as Partial<ProcessConfig> & { verbose?: boolean; sttEnabled?: boolean };
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

/** Parse [speech] table including nested [speech.tts] / [speech.stt] / providers. */
export function normalizeSpeechToml(
  s: Record<string, unknown>,
): SpeechSettings {
  const out: SpeechSettings = {};

  // Flat provider keys
  if (s.tts_provider !== undefined || s.ttsProvider !== undefined) {
    out.ttsProvider = parseSpeechProvider(s.tts_provider ?? s.ttsProvider);
  }
  if (s.stt_provider !== undefined || s.sttProvider !== undefined) {
    out.sttProvider = parseSpeechProvider(s.stt_provider ?? s.sttProvider);
  }

  // Nested [speech.tts] / [speech.stt]
  const ttsTable =
    s.tts && typeof s.tts === "object" && !Array.isArray(s.tts)
      ? (s.tts as Record<string, unknown>)
      : undefined;
  const sttTable =
    s.stt && typeof s.stt === "object" && !Array.isArray(s.stt)
      ? (s.stt as Record<string, unknown>)
      : undefined;

  if (ttsTable) {
    if (ttsTable.provider !== undefined) {
      out.ttsProvider = parseSpeechProvider(ttsTable.provider);
    }
    if (ttsTable.enabled === false || ttsTable.enabled === "false") {
      out.ttsEnabled = false;
    }
    // Provider-specific under [speech.tts]
    if (ttsTable.model !== undefined) {
      // apply to both; resolve at runtime by selected provider
      out.openaiTtsModel = str(ttsTable.model) ?? out.openaiTtsModel;
      out.elevenlabsTtsModel = str(ttsTable.model) ?? out.elevenlabsTtsModel;
    }
    if (ttsTable.voice !== undefined) {
      out.openaiTtsVoice = str(ttsTable.voice) ?? out.openaiTtsVoice;
      out.elevenlabsVoiceId = str(ttsTable.voice) ?? out.elevenlabsVoiceId;
    }
    if (ttsTable.format !== undefined) {
      const f = str(ttsTable.format)?.toLowerCase();
      if (
        f === "mp3" ||
        f === "opus" ||
        f === "aac" ||
        f === "flac" ||
        f === "wav" ||
        f === "pcm"
      ) {
        out.openaiTtsFormat = f;
      }
    }
  }

  if (sttTable) {
    if (sttTable.provider !== undefined) {
      out.sttProvider = parseSpeechProvider(sttTable.provider);
    }
    if (sttTable.enabled === false || sttTable.enabled === "false") {
      out.sttEnabled = false;
    }
    if (sttTable.model !== undefined) {
      out.openaiSttModel = str(sttTable.model) ?? out.openaiSttModel;
      out.elevenlabsSttModel = str(sttTable.model) ?? out.elevenlabsSttModel;
    }
  } else if (typeof s.stt === "boolean") {
    out.sttEnabled = s.stt;
  } else if (s.stt_enabled !== undefined) {
    out.sttEnabled = Boolean(s.stt_enabled);
  }

  if (s.tts === false || s.tts === "false" || s.tts === 0) {
    out.ttsEnabled = false;
  } else if (typeof s.tts === "boolean") {
    out.ttsEnabled = s.tts;
  }

  // Nested provider tables
  const el =
    s.elevenlabs && typeof s.elevenlabs === "object" && !Array.isArray(s.elevenlabs)
      ? (s.elevenlabs as Record<string, unknown>)
      : undefined;
  if (el) {
    out.elevenlabsApiKey = str(el.api_key ?? el.apiKey);
    out.elevenlabsVoiceId = str(el.voice_id ?? el.voiceId) ?? out.elevenlabsVoiceId;
    out.elevenlabsTtsModel =
      str(el.tts_model ?? el.ttsModel ?? el.model) ?? out.elevenlabsTtsModel;
    out.elevenlabsSttModel =
      str(el.stt_model ?? el.sttModel) ?? out.elevenlabsSttModel;
    out.elevenlabsBaseUrl = str(el.base_url ?? el.baseUrl);
    if (el.stability !== undefined) out.elevenlabsStability = Number(el.stability);
    if (el.similarity_boost !== undefined || el.similarityBoost !== undefined) {
      out.elevenlabsSimilarityBoost = Number(
        el.similarity_boost ?? el.similarityBoost,
      );
    }
  }

  const oai =
    s.openai && typeof s.openai === "object" && !Array.isArray(s.openai)
      ? (s.openai as Record<string, unknown>)
      : undefined;
  if (oai) {
    out.openaiApiKey = str(oai.api_key ?? oai.apiKey);
    out.openaiBaseUrl = str(oai.base_url ?? oai.baseUrl);
    out.openaiTtsModel =
      str(oai.tts_model ?? oai.ttsModel) ?? out.openaiTtsModel;
    out.openaiTtsVoice =
      str(oai.tts_voice ?? oai.ttsVoice ?? oai.voice) ?? out.openaiTtsVoice;
    out.openaiSttModel =
      str(oai.stt_model ?? oai.sttModel) ?? out.openaiSttModel;
    const fmt = str(oai.tts_format ?? oai.ttsFormat ?? oai.format)?.toLowerCase();
    if (
      fmt === "mp3" ||
      fmt === "opus" ||
      fmt === "aac" ||
      fmt === "flac" ||
      fmt === "wav" ||
      fmt === "pcm"
    ) {
      out.openaiTtsFormat = fmt;
    }
  }

  // Flat legacy keys
  out.elevenlabsApiKey =
    str(s.elevenlabs_api_key ?? s.elevenlabsApiKey) ?? out.elevenlabsApiKey;
  out.elevenlabsVoiceId =
    str(s.elevenlabs_voice_id ?? s.elevenlabsVoiceId) ?? out.elevenlabsVoiceId;
  out.elevenlabsTtsModel =
    str(s.elevenlabs_tts_model ?? s.elevenlabsTtsModel) ?? out.elevenlabsTtsModel;
  out.elevenlabsSttModel =
    str(s.elevenlabs_stt_model ?? s.elevenlabsSttModel) ?? out.elevenlabsSttModel;
  out.elevenlabsBaseUrl =
    str(s.elevenlabs_base_url ?? s.elevenlabsBaseUrl) ?? out.elevenlabsBaseUrl;
  out.openaiApiKey = str(s.openai_api_key ?? s.openaiApiKey) ?? out.openaiApiKey;
  out.openaiBaseUrl =
    str(s.openai_base_url ?? s.openaiBaseUrl) ?? out.openaiBaseUrl;
  out.openaiTtsModel =
    str(s.openai_tts_model ?? s.openaiTtsModel) ?? out.openaiTtsModel;
  out.openaiTtsVoice =
    str(s.openai_tts_voice ?? s.openaiTtsVoice) ?? out.openaiTtsVoice;
  out.openaiSttModel =
    str(s.openai_stt_model ?? s.openaiSttModel) ?? out.openaiSttModel;

  return out;
}

export function parseTomlConfig(text: string): Record<string, unknown> {
  const parsed = Bun.TOML.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config TOML root must be a table");
  }
  return parsed as Record<string, unknown>;
}

export function loadTomlFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  try {
    return parseTomlConfig(text);
  } catch (err) {
    throw new Error(
      `Failed to parse config ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function firstEnv(
  env: Record<string, string | undefined>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * Load process config from TOML (preferred) + defaults + optional legacy env.
 */
export function loadConfig(options: LoadConfigOptions = {}): ProcessConfig {
  const env = options.env ?? process.env;
  const requireTelegram = options.requireTelegram !== false;

  let configPath: string | undefined;
  let rawFile: Record<string, unknown> = {};
  if (options.file) {
    rawFile = options.file;
  } else if (!options.skipFile) {
    configPath = resolveConfigFilePath(options);
    if (configPath) {
      if (!existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
      }
      rawFile = loadTomlFile(configPath);
    }
  }
  const file = normalizeToml(rawFile);

  const botTokenRaw =
    str(file.botToken) ??
    firstEnv(env, "ACPBOT_BOT_TOKEN", "TACP_BOT_TOKEN", "BOT_TOKEN");
  const botTokenPlaceholder =
    !botTokenRaw ||
    botTokenRaw.includes("REPLACE_ME") ||
    /^123456:/i.test(botTokenRaw);
  const botToken = botTokenPlaceholder ? "" : botTokenRaw;
  if (requireTelegram && !botToken) {
    throw new Error(
      missingMsg(
        "bot_token",
        configPath,
        "Run `acpbot` once in a terminal for first-run setup, or set bot_token in config.toml.",
      ),
    );
  }

  const operatorRaw =
    file.operatorUserId !== undefined
      ? String(file.operatorUserId)
      : firstEnv(
          env,
          "ACPBOT_OPERATOR_USER_ID",
          "TACP_OPERATOR_USER_ID",
          "OPERATOR_USER_ID",
        );
  // 0 = unclaimed: first private Telegram user who messages becomes operator.
  const operatorUserId =
    operatorRaw && Number.isFinite(Number(operatorRaw))
      ? Number(operatorRaw)
      : 0;
  if (requireTelegram && operatorRaw && !Number.isFinite(Number(operatorRaw))) {
    throw new Error(`Invalid operator_user_id: ${operatorRaw}`);
  }

  const storePathRaw =
    str(file.storePath as string | undefined) ??
    firstEnv(env, "ACPBOT_STORE_PATH", "TACP_STORE_PATH") ??
    defaultStorePath(env);
  const storePath = resolvePath(storePathRaw, env);

  const stateDirRaw =
    str(file.stateDir as string | undefined) ??
    firstEnv(env, "ACPBOT_STATE_DIR", "TACP_STATE_DIR") ??
    defaultStateDir(env);
  const stateDir = resolveStateDir(resolvePath(stateDirRaw, env), env);

  let repos = file.repos as Record<string, string> | undefined;
  const reposJson = firstEnv(env, "ACPBOT_REPOS_JSON", "TACP_REPOS_JSON");
  if (!repos && reposJson) {
    let raw = reposJson.trim();
    if (
      (raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"'))
    ) {
      raw = raw.slice(1, -1);
    }
    repos = JSON.parse(raw) as Record<string, string>;
  }
  if (repos) {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(repos)) {
      resolved[k] = resolvePath(String(v), env);
    }
    repos = resolved;
  }

  const operatorChatIdRaw =
    file.operatorChatId !== undefined
      ? String(file.operatorChatId)
      : firstEnv(env, "ACPBOT_OPERATOR_CHAT_ID", "TACP_OPERATOR_CHAT_ID");
  const operatorChatId = operatorChatIdRaw
    ? Number(operatorChatIdRaw)
    : undefined;

  const verbose =
    file.verbose === true ||
    firstEnv(env, "ACPBOT_VERBOSE", "TACP_VERBOSE") === "1";
  const logLevel = parseLogLevel(
    (file.logLevel as string | undefined) ??
      firstEnv(env, "ACPBOT_LOG_LEVEL", "TACP_LOG_LEVEL"),
    verbose,
  );

  const config: ProcessConfig = {
    botToken: botToken ?? "",
    storePath,
    stateDir,
    operatorUserId,
    defaultAgent: normalizeAgentName(
      str(file.defaultAgent as string | undefined) ??
        firstEnv(env, "ACPBOT_DEFAULT_AGENT", "TACP_DEFAULT_AGENT") ??
        "grok-build",
    ),
    logLevel,
  };
  if (configPath) config.configPath = configPath;
  if (verbose) config.verbose = true;
  if (operatorChatId !== undefined && Number.isFinite(operatorChatId)) {
    config.operatorChatId = operatorChatId;
  }
  if (repos && Object.keys(repos).length > 0) config.repos = repos;

  // Skills
  const skillRoots: string[] = [];
  skillRoots.push(join(import.meta.dir, "..", "skills"));
  if (Array.isArray(file.skillRoots)) {
    for (const p of file.skillRoots) {
      if (typeof p === "string" && p.trim()) {
        skillRoots.push(resolvePath(p, env));
      }
    }
  }
  const skillEnv = firstEnv(env, "ACPBOT_SKILL_ROOTS", "TACP_SKILL_ROOTS");
  if (skillEnv) {
    for (const part of skillEnv.split(/[:;,]/)) {
      const p = part.trim();
      if (p) skillRoots.push(resolvePath(p, env));
    }
  }
  const home = homeDir(env);
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
  config.skillRoots = [...new Set(skillRoots)];

  // Features
  const media =
    file.acpMediaAttachments === true ||
    firstEnv(env, "ACPBOT_ACP_MEDIA_ATTACHMENTS", "TACP_ACP_MEDIA_ATTACHMENTS") ===
      "1" ||
    firstEnv(env, "ACPBOT_ACP_MEDIA_ATTACHMENTS", "TACP_ACP_MEDIA_ATTACHMENTS") ===
      "true";
  if (media) config.acpMediaAttachments = true;

  const ttsModeRaw =
    (file.ttsMode as string | undefined) ??
    firstEnv(env, "ACPBOT_TTS_MODE", "TACP_TTS_MODE") ??
    (firstEnv(env, "TACP_TTS") === "0" || firstEnv(env, "TACP_TTS") === "false"
      ? "off"
      : undefined);
  if (ttsModeRaw !== undefined) {
    const n = String(ttsModeRaw).trim().toLowerCase();
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

  if (
    file.mcpEnabled === false ||
    firstEnv(env, "ACPBOT_MCP", "TACP_MCP") === "0" ||
    firstEnv(env, "ACPBOT_MCP", "TACP_MCP") === "false"
  ) {
    config.mcpEnabled = false;
  } else {
    config.mcpEnabled = true;
  }

  // OAuth / schedule / agents / speech from file + env
  config.oauthCallbackBase =
    str(file.oauthCallbackBase as string | undefined) ??
    firstEnv(env, "ACPBOT_OAUTH_CALLBACK_BASE", "TACP_OAUTH_CALLBACK_BASE");
  config.oauthListenHost =
    str(file.oauthListenHost as string | undefined) ??
    firstEnv(env, "ACPBOT_OAUTH_LISTEN_HOST", "TACP_OAUTH_LISTEN_HOST");
  const portRaw =
    file.oauthListenPort !== undefined
      ? String(file.oauthListenPort)
      : firstEnv(env, "ACPBOT_OAUTH_LISTEN_PORT", "TACP_OAUTH_LISTEN_PORT");
  if (portRaw) {
    const n = Number(portRaw);
    if (Number.isFinite(n)) config.oauthListenPort = n;
  }

  const tickRaw =
    file.scheduleTickMs !== undefined
      ? String(file.scheduleTickMs)
      : firstEnv(env, "ACPBOT_SCHEDULE_TICK_MS", "TACP_SCHEDULE_TICK_MS");
  if (tickRaw) {
    const n = Number(tickRaw);
    if (Number.isFinite(n) && n > 0) config.scheduleTickMs = n;
  }

  config.agentCommandJson =
    str(file.agentCommandJson as string | undefined) ??
    firstEnv(env, "ACPBOT_AGENT_COMMAND_JSON", "TACP_AGENT_COMMAND_JSON");
  config.claudeAcpPkg =
    str(file.claudeAcpPkg as string | undefined) ??
    firstEnv(env, "ACPBOT_CLAUDE_ACP_PKG", "TACP_CLAUDE_ACP_PKG");
  config.codexAcpPkg =
    str(file.codexAcpPkg as string | undefined) ??
    firstEnv(env, "ACPBOT_CODEX_ACP_PKG", "TACP_CODEX_ACP_PKG");

  // Speech: TOML [speech] + nested tables; env fills gaps via merge in speechFromConfig
  const speechFile = file.speech;
  if (speechFile) {
    config.speech = { ...speechFile };
  }
  // Env-only provider overrides still land via applyConfigToEnv + speechFromConfig merge
  const ttsProvEnv = firstEnv(env, "ACPBOT_TTS_PROVIDER", "TACP_TTS_PROVIDER");
  const sttProvEnv = firstEnv(env, "ACPBOT_STT_PROVIDER", "TACP_STT_PROVIDER");
  if (ttsProvEnv || sttProvEnv || speechFile) {
    config.speech = {
      ...(config.speech ?? {}),
      ...(ttsProvEnv ? { ttsProvider: parseSpeechProvider(ttsProvEnv) } : {}),
      ...(sttProvEnv ? { sttProvider: parseSpeechProvider(sttProvEnv) } : {}),
    };
  }
  // Fill secrets from env when TOML omitted them
  if (config.speech || firstEnv(env, "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "TACP_OPENAI_API_KEY")) {
    config.speech = {
      ...(config.speech ?? {}),
      elevenlabsApiKey:
        config.speech?.elevenlabsApiKey ?? firstEnv(env, "ELEVENLABS_API_KEY"),
      elevenlabsVoiceId:
        config.speech?.elevenlabsVoiceId ?? firstEnv(env, "ELEVENLABS_VOICE_ID"),
      elevenlabsTtsModel:
        config.speech?.elevenlabsTtsModel ??
        firstEnv(env, "ELEVENLABS_TTS_MODEL"),
      elevenlabsSttModel:
        config.speech?.elevenlabsSttModel ??
        firstEnv(env, "ELEVENLABS_STT_MODEL"),
      elevenlabsBaseUrl:
        config.speech?.elevenlabsBaseUrl ?? firstEnv(env, "ELEVENLABS_BASE_URL"),
      openaiApiKey:
        config.speech?.openaiApiKey ??
        firstEnv(env, "OPENAI_API_KEY", "TACP_OPENAI_API_KEY", "ACPBOT_OPENAI_API_KEY"),
      openaiBaseUrl:
        config.speech?.openaiBaseUrl ??
        firstEnv(env, "ACPBOT_OPENAI_BASE_URL", "TACP_OPENAI_BASE_URL", "OPENAI_BASE_URL"),
      openaiTtsModel:
        config.speech?.openaiTtsModel ??
        firstEnv(env, "ACPBOT_OPENAI_TTS_MODEL", "OPENAI_TTS_MODEL"),
      openaiTtsVoice:
        config.speech?.openaiTtsVoice ??
        firstEnv(env, "ACPBOT_OPENAI_TTS_VOICE", "TACP_TTS_VOICE", "OPENAI_TTS_VOICE"),
      openaiSttModel:
        config.speech?.openaiSttModel ??
        firstEnv(env, "ACPBOT_OPENAI_STT_MODEL", "OPENAI_STT_MODEL"),
    };
  }
  if (
    firstEnv(env, "ACPBOT_STT", "TACP_STT") === "0" ||
    firstEnv(env, "ACPBOT_STT", "TACP_STT") === "false"
  ) {
    config.speech = { ...(config.speech ?? {}), sttEnabled: false };
  }
  if (
    firstEnv(env, "ACPBOT_TTS", "TACP_TTS") === "0" ||
    firstEnv(env, "ACPBOT_TTS", "TACP_TTS") === "false"
  ) {
    config.speech = { ...(config.speech ?? {}), ttsEnabled: false };
  }

  return config;
}

function missingMsg(
  field: string,
  configPath: string | undefined,
  hint: string,
): string {
  const where = configPath
    ? `config file ${configPath}`
    : `config file (${defaultConfigPath()})`;
  return `Missing ${field} in ${where}. ${hint}`;
}

/**
 * Publish config into process.env so legacy modules (oauth, agent-launch,
 * speech, scheduler) keep working without per-call rewrites.
 * Call once at process boot after loadConfig.
 */
export function applyConfigToEnv(
  cfg: ProcessConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.ACPBOT_STATE_DIR = cfg.stateDir;
  env.TACP_STATE_DIR = cfg.stateDir;
  env.ACPBOT_STORE_PATH = cfg.storePath;
  env.TACP_STORE_PATH = cfg.storePath;
  if (cfg.botToken) {
    env.ACPBOT_BOT_TOKEN = cfg.botToken;
    env.TACP_BOT_TOKEN = cfg.botToken;
  }
  env.ACPBOT_OPERATOR_USER_ID = String(cfg.operatorUserId);
  env.TACP_OPERATOR_USER_ID = String(cfg.operatorUserId);
  if (cfg.operatorChatId !== undefined) {
    env.ACPBOT_OPERATOR_CHAT_ID = String(cfg.operatorChatId);
    env.TACP_OPERATOR_CHAT_ID = String(cfg.operatorChatId);
  }
  if (cfg.defaultAgent) {
    env.ACPBOT_DEFAULT_AGENT = cfg.defaultAgent;
    env.TACP_DEFAULT_AGENT = cfg.defaultAgent;
  }
  env.ACPBOT_LOG_LEVEL = cfg.logLevel;
  env.TACP_LOG_LEVEL = cfg.logLevel;
  if (cfg.verbose) {
    env.ACPBOT_VERBOSE = "1";
    env.TACP_VERBOSE = "1";
  }
  if (cfg.repos) {
    const json = JSON.stringify(cfg.repos);
    env.ACPBOT_REPOS_JSON = json;
    env.TACP_REPOS_JSON = json;
  }
  if (cfg.oauthCallbackBase) {
    env.ACPBOT_OAUTH_CALLBACK_BASE = cfg.oauthCallbackBase;
    env.TACP_OAUTH_CALLBACK_BASE = cfg.oauthCallbackBase;
  }
  if (cfg.oauthListenHost) {
    env.ACPBOT_OAUTH_LISTEN_HOST = cfg.oauthListenHost;
    env.TACP_OAUTH_LISTEN_HOST = cfg.oauthListenHost;
  }
  if (cfg.oauthListenPort !== undefined) {
    env.ACPBOT_OAUTH_LISTEN_PORT = String(cfg.oauthListenPort);
    env.TACP_OAUTH_LISTEN_PORT = String(cfg.oauthListenPort);
  }
  if (cfg.scheduleTickMs !== undefined) {
    env.ACPBOT_SCHEDULE_TICK_MS = String(cfg.scheduleTickMs);
    env.TACP_SCHEDULE_TICK_MS = String(cfg.scheduleTickMs);
  }
  if (cfg.mcpEnabled === false) {
    env.ACPBOT_MCP = "0";
    env.TACP_MCP = "0";
  } else {
    env.ACPBOT_MCP = "1";
    env.TACP_MCP = "1";
  }
  if (cfg.ttsMode) {
    env.ACPBOT_TTS_MODE = cfg.ttsMode;
    env.TACP_TTS_MODE = cfg.ttsMode;
  }
  if (cfg.acpMediaAttachments) {
    env.ACPBOT_ACP_MEDIA_ATTACHMENTS = "1";
    env.TACP_ACP_MEDIA_ATTACHMENTS = "1";
  }
  if (cfg.agentCommandJson) {
    env.ACPBOT_AGENT_COMMAND_JSON = cfg.agentCommandJson;
    env.TACP_AGENT_COMMAND_JSON = cfg.agentCommandJson;
  }
  if (cfg.claudeAcpPkg) {
    env.ACPBOT_CLAUDE_ACP_PKG = cfg.claudeAcpPkg;
    env.TACP_CLAUDE_ACP_PKG = cfg.claudeAcpPkg;
  }
  if (cfg.codexAcpPkg) {
    env.ACPBOT_CODEX_ACP_PKG = cfg.codexAcpPkg;
    env.TACP_CODEX_ACP_PKG = cfg.codexAcpPkg;
  }
  const sp = cfg.speech;
  if (sp) {
    if (sp.ttsProvider) {
      env.ACPBOT_TTS_PROVIDER = sp.ttsProvider;
      env.TACP_TTS_PROVIDER = sp.ttsProvider;
    }
    if (sp.sttProvider) {
      env.ACPBOT_STT_PROVIDER = sp.sttProvider;
      env.TACP_STT_PROVIDER = sp.sttProvider;
    }
    if (sp.sttEnabled === false) {
      env.ACPBOT_STT = "0";
      env.TACP_STT = "0";
    }
    if (sp.ttsEnabled === false) {
      env.ACPBOT_TTS = "0";
      env.TACP_TTS = "0";
    }
    if (sp.elevenlabsApiKey) env.ELEVENLABS_API_KEY = sp.elevenlabsApiKey;
    if (sp.elevenlabsVoiceId) env.ELEVENLABS_VOICE_ID = sp.elevenlabsVoiceId;
    if (sp.elevenlabsTtsModel) env.ELEVENLABS_TTS_MODEL = sp.elevenlabsTtsModel;
    if (sp.elevenlabsSttModel) env.ELEVENLABS_STT_MODEL = sp.elevenlabsSttModel;
    if (sp.elevenlabsBaseUrl) env.ELEVENLABS_BASE_URL = sp.elevenlabsBaseUrl;
    if (sp.openaiApiKey) {
      env.OPENAI_API_KEY = sp.openaiApiKey;
      env.TACP_OPENAI_API_KEY = sp.openaiApiKey;
      env.ACPBOT_OPENAI_API_KEY = sp.openaiApiKey;
    }
    if (sp.openaiBaseUrl) {
      env.TACP_OPENAI_BASE_URL = sp.openaiBaseUrl;
      env.OPENAI_BASE_URL = sp.openaiBaseUrl;
      env.ACPBOT_OPENAI_BASE_URL = sp.openaiBaseUrl;
    }
    if (sp.openaiTtsModel) {
      env.ACPBOT_OPENAI_TTS_MODEL = sp.openaiTtsModel;
      env.OPENAI_TTS_MODEL = sp.openaiTtsModel;
    }
    if (sp.openaiTtsVoice) {
      env.ACPBOT_OPENAI_TTS_VOICE = sp.openaiTtsVoice;
      env.TACP_TTS_VOICE = sp.openaiTtsVoice;
      env.OPENAI_TTS_VOICE = sp.openaiTtsVoice;
    }
    if (sp.openaiTtsFormat) {
      env.ACPBOT_OPENAI_TTS_FORMAT = sp.openaiTtsFormat;
      env.OPENAI_TTS_FORMAT = sp.openaiTtsFormat;
    }
    if (sp.openaiSttModel) {
      env.ACPBOT_OPENAI_STT_MODEL = sp.openaiSttModel;
      env.OPENAI_STT_MODEL = sp.openaiSttModel;
    }
  }
}
