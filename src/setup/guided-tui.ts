/**
 * Guided TUI onboarding with @clack/prompts.
 * Collects bot token, operator, agent, repos, speech API keys, optional OAuth,
 * and can install macOS LaunchAgents or Linux systemd user units.
 */
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ensureAcpbotLayout,
  isPlaceholderBotToken,
  writeConfigToml,
  type SetupAnswers,
} from "../config-setup";
import {
  homeDir,
  loadConfig,
  normalizeAgentName,
  resolvePath,
  type LoadConfigOptions,
  type ProcessConfig,
} from "../config";
import {
  detectDaemonPlatform,
  installUserDaemons,
  resolveExecutable,
} from "./daemon-install";

export type GuidedSetupResult = {
  configPath: string;
  cfg: ProcessConfig;
  daemon?: {
    installed: boolean;
    messages: string[];
  };
};

function cancelled(v: unknown): boolean {
  return p.isCancel(v);
}

function abort(): never {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

/** Full config TOML from guided answers (includes speech / oauth). */
export function renderFullConfigToml(a: {
  botToken: string;
  defaultAgent: string;
  logLevel: string;
  repos: Record<string, string>;
  ttsMode: string;
  permissionMode: string;
  ttsProvider: string;
  sttProvider: string;
  openaiApiKey?: string;
  openaiTtsVoice?: string;
  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  oauthCallbackBase?: string;
}): string {
  const lines: string[] = [
    `# acpbot configuration`,
    `# Written by guided setup (${new Date().toISOString().slice(0, 10)}).`,
    `# Re-run: acpbot setup`,
    ``,
    `bot_token = ${tomlString(a.botToken)}`,
    ``,
    `default_agent = ${tomlString(a.defaultAgent)}`,
    `log_level = ${tomlString(a.logLevel)}`,
    ``,
  ];

  const repoEntries = Object.entries(a.repos);
  if (repoEntries.length > 0) {
    lines.push(`[repos]`);
    for (const [k, v] of repoEntries) {
      lines.push(`${k} = ${tomlString(v)}`);
    }
    lines.push(``);
  } else {
    lines.push(`# [repos]`);
    lines.push(`# demo = "/absolute/path/to/repo"`);
    lines.push(``);
  }

  lines.push(`[features]`);
  lines.push(`mcp = true`);
  lines.push(`tts_mode = ${tomlString(a.ttsMode)}`);
  lines.push(
    `permission_mode = ${tomlString(a.permissionMode)}  # ask | always-approve`,
  );
  lines.push(``);

  lines.push(`[speech]`);
  lines.push(`tts_provider = ${tomlString(a.ttsProvider)}`);
  lines.push(`stt_provider = ${tomlString(a.sttProvider)}`);
  lines.push(``);

  if (a.openaiApiKey || a.openaiTtsVoice) {
    lines.push(`[speech.openai]`);
    if (a.openaiApiKey) lines.push(`api_key = ${tomlString(a.openaiApiKey)}`);
    if (a.openaiTtsVoice) {
      lines.push(`tts_voice = ${tomlString(a.openaiTtsVoice)}`);
    }
    lines.push(`# tts_model = "tts-1"`);
    lines.push(`# stt_model = "whisper-1"`);
    lines.push(``);
  }

  if (a.elevenlabsApiKey || a.elevenlabsVoiceId) {
    lines.push(`[speech.elevenlabs]`);
    if (a.elevenlabsApiKey) {
      lines.push(`api_key = ${tomlString(a.elevenlabsApiKey)}`);
    }
    if (a.elevenlabsVoiceId) {
      lines.push(`voice_id = ${tomlString(a.elevenlabsVoiceId)}`);
    }
    lines.push(``);
  }

  if (a.oauthCallbackBase) {
    lines.push(`[oauth]`);
    lines.push(`callback_base = ${tomlString(a.oauthCallbackBase)}`);
    lines.push(`# listen_port = 8788`);
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Full guided TUI setup. Prefer this over the simple readline wizard.
 */
export async function runGuidedSetupTui(
  options: LoadConfigOptions = {},
): Promise<GuidedSetupResult> {
  const env = options.env ?? process.env;
  const layout = ensureAcpbotLayout(options);

  let existing: ProcessConfig | undefined;
  try {
    existing = loadConfig({
      configPath: layout.configPath,
      env,
      requireTelegram: false,
    });
  } catch {
    existing = undefined;
  }

  console.clear?.();
  p.intro("acpbot setup");

  p.note(
    [
      "This wizard writes ~/.config/acpbot/config.toml",
      "and can install background services on macOS or Linux.",
      "",
      "Prereqs:",
      "  • Telegram bot from @BotFather (topics in private chats)",
      "  • Agent CLI on PATH: grok · claude · codex · opencode",
      "  • Optional: OpenAI / ElevenLabs keys for voice",
    ].join("\n"),
    "Welcome",
  );

  // ── Telegram ──────────────────────────────────────────────────────────
  p.log.step("Telegram");

  const keepToken =
    existing && !isPlaceholderBotToken(existing.botToken)
      ? existing.botToken
      : undefined;

  let botToken = keepToken ?? "";
  if (keepToken) {
    const keep = await p.confirm({
      message: `Keep existing bot token (…${keepToken.slice(-6)})?`,
      initialValue: true,
    });
    if (cancelled(keep)) abort();
    if (!keep) botToken = "";
  }
  while (isPlaceholderBotToken(botToken)) {
    const entered = await p.text({
      message: "Bot token from @BotFather",
      placeholder: "123456:AA…",
      validate: (v) => {
        if (!v?.trim()) return "Token is required";
        if (isPlaceholderBotToken(v)) return "Enter a real bot token";
      },
    });
    if (cancelled(entered)) abort();
    botToken = String(entered).trim();
  }

  // ── Agent ─────────────────────────────────────────────────────────────
  p.log.step("Agent");

  const agent = await p.select({
    message: "Default coding agent",
    options: [
      { value: "grok-build", label: "Grok Build", hint: "grok agent stdio" },
      { value: "claude", label: "Claude", hint: "claude-agent-acp" },
      { value: "codex", label: "Codex", hint: "codex-acp" },
      { value: "opencode", label: "OpenCode", hint: "opencode acp" },
    ],
    initialValue: existing?.defaultAgent ?? "grok-build",
  });
  if (cancelled(agent)) abort();
  const defaultAgent = normalizeAgentName(String(agent));

  // ── Tool permissions ──────────────────────────────────────────────────
  p.log.step("Tool permissions");
  const permSel = await p.select({
    message: "Default tool permission policy for new sessions",
    options: [
      {
        value: "ask",
        label: "Ask (recommended)",
        hint: "Telegram approve/reject buttons for tools",
      },
      {
        value: "always-approve",
        label: "Always-approve (yolo)",
        hint: "Auto-allow tools — use only on trusted machines",
      },
    ],
    initialValue: existing?.permissionMode ?? "ask",
  });
  if (cancelled(permSel)) abort();
  const permissionMode = String(permSel) === "always-approve"
    ? "always-approve"
    : "ask";

  // ── Repos ─────────────────────────────────────────────────────────────
  p.log.step("Workspace");

  const repos: Record<string, string> = { ...(existing?.repos ?? {}) };
  const addRepo = await p.confirm({
    message:
      Object.keys(repos).length > 0
        ? `Add another repo? (have: ${Object.keys(repos).join(", ")})`
        : "Add a workspace repo for /new?",
    initialValue: Object.keys(repos).length === 0,
  });
  if (cancelled(addRepo)) abort();

  if (addRepo) {
    const key = await p.text({
      message: "Repo key (short label in /new)",
      placeholder: "demo",
      initialValue: "demo",
      validate: (v) => (!v?.trim() ? "Required" : undefined),
    });
    if (cancelled(key)) abort();
    const pathRaw = await p.text({
      message: "Absolute path to the repo",
      placeholder: join(homeDir(env), "code", "demo"),
      initialValue: join(homeDir(env), "code"),
      validate: (v) => {
        if (!v?.trim()) return "Required";
      },
    });
    if (cancelled(pathRaw)) abort();
    repos[String(key).trim()] = resolvePath(String(pathRaw), env);
  }

  // ── Speech / API keys ─────────────────────────────────────────────────
  p.log.step("Speech & API keys (optional)");

  const wantSpeech = await p.confirm({
    message: "Configure TTS / STT (voice notes)?",
    initialValue: Boolean(
      existing?.speech?.openaiApiKey || existing?.speech?.elevenlabsApiKey,
    ),
  });
  if (cancelled(wantSpeech)) abort();

  let ttsProvider = existing?.speech?.ttsProvider ?? "auto";
  let sttProvider = existing?.speech?.sttProvider ?? "auto";
  let ttsMode = existing?.ttsMode ?? "agent";
  let openaiApiKey = existing?.speech?.openaiApiKey;
  let openaiTtsVoice = existing?.speech?.openaiTtsVoice ?? "alloy";
  let elevenlabsApiKey = existing?.speech?.elevenlabsApiKey;
  let elevenlabsVoiceId = existing?.speech?.elevenlabsVoiceId;

  if (wantSpeech) {
    const ttsModeSel = await p.select({
      message: "When should the agent speak?",
      options: [
        {
          value: "agent",
          label: "Only when it calls speak (recommended)",
        },
        { value: "always", label: "More aggressively on replies" },
        { value: "off", label: "Never" },
      ],
      initialValue: ttsMode,
    });
    if (cancelled(ttsModeSel)) abort();
    ttsMode = String(ttsModeSel) as "agent" | "always" | "off";

    const provider = await p.select({
      message: "Speech provider (TTS + STT)",
      options: [
        {
          value: "auto",
          label: "Auto",
          hint: "ElevenLabs if keyed, else OpenAI",
        },
        { value: "openai", label: "OpenAI", hint: "Whisper + TTS" },
        { value: "elevenlabs", label: "ElevenLabs", hint: "Scribe + TTS" },
        { value: "off", label: "Off" },
      ],
      initialValue: ttsProvider === sttProvider ? ttsProvider : "auto",
    });
    if (cancelled(provider)) abort();
    ttsProvider = String(provider);
    sttProvider = String(provider);

    if (provider === "openai" || provider === "auto") {
      const oai = await p.password({
        message: "OpenAI API key (optional, Enter to skip)",
      });
      if (cancelled(oai)) abort();
      if (String(oai).trim()) openaiApiKey = String(oai).trim();

      if (openaiApiKey) {
        const voice = await p.select({
          message: "OpenAI TTS voice",
          options: [
            "alloy",
            "ash",
            "ballad",
            "coral",
            "echo",
            "fable",
            "nova",
            "onyx",
            "sage",
            "shimmer",
            "verse",
          ].map((v) => ({ value: v, label: v })),
          initialValue: openaiTtsVoice ?? "alloy",
        });
        if (cancelled(voice)) abort();
        openaiTtsVoice = String(voice);
      }
    }

    if (provider === "elevenlabs" || provider === "auto") {
      const el = await p.password({
        message: "ElevenLabs API key (optional, Enter to skip)",
      });
      if (cancelled(el)) abort();
      if (String(el).trim()) elevenlabsApiKey = String(el).trim();

      if (elevenlabsApiKey) {
        const vid = await p.text({
          message: "ElevenLabs voice id (optional)",
          placeholder: "premade/cloned voice id",
          initialValue: elevenlabsVoiceId,
        });
        if (cancelled(vid)) abort();
        if (String(vid).trim()) elevenlabsVoiceId = String(vid).trim();
      }
    }
  }

  // ── OAuth (optional) ──────────────────────────────────────────────────
  p.log.step("Remote MCP OAuth (optional)");

  let oauthCallbackBase = existing?.oauthCallbackBase;
  const wantOauth = await p.confirm({
    message: "Configure OAuth callback for remote MCP?",
    initialValue: Boolean(oauthCallbackBase),
  });
  if (cancelled(wantOauth)) abort();
  if (wantOauth) {
    const base = await p.text({
      message: "Public callback base URL (phone browser must reach it)",
      placeholder: "https://your-host.ts.net",
      initialValue: oauthCallbackBase,
    });
    if (cancelled(base)) abort();
    oauthCallbackBase = String(base).trim() || undefined;
  }

  // ── Log level ─────────────────────────────────────────────────────────
  const logLevel = await p.select({
    message: "Log level",
    options: [
      { value: "info", label: "info" },
      { value: "debug", label: "debug" },
      { value: "warn", label: "warn" },
    ],
    initialValue: existing?.logLevel ?? "info",
  });
  if (cancelled(logLevel)) abort();

  // ── Write config ──────────────────────────────────────────────────────
  const s = p.spinner();
  s.start("Writing config.toml");
  const body = renderFullConfigToml({
    botToken,
    defaultAgent,
    logLevel: String(logLevel),
    repos,
    ttsMode,
    permissionMode,
    ttsProvider,
    sttProvider,
    openaiApiKey,
    openaiTtsVoice,
    elevenlabsApiKey,
    elevenlabsVoiceId,
    oauthCallbackBase,
  });
  writeConfigToml(layout.configPath, body);
  s.stop(`Saved ${layout.configPath}`);

  const cfg = loadConfig({
    configPath: layout.configPath,
    env,
    requireTelegram: true,
  });

  // ── Daemon install ────────────────────────────────────────────────────
  p.log.step("Background service");

  const platform = detectDaemonPlatform();
  const workerBin = resolveExecutable("acpbot", env as NodeJS.ProcessEnv);
  const hostBin = resolveExecutable("acpbot-host", env as NodeJS.ProcessEnv);

  let daemonResult: GuidedSetupResult["daemon"];

  if (platform === "unsupported") {
    p.log.warn(
      `Daemon install not available on ${process.platform}. Run acpbot-host and acpbot manually.`,
    );
  } else if (!workerBin || !hostBin) {
    p.log.warn(
      "acpbot / acpbot-host not found on PATH — skip service install.\n" +
        "  Put release binaries in /usr/local/bin (or similar), then: acpbot setup",
    );
  } else {
    const install = await p.confirm({
      message: `Install host + worker as a background service (${platform === "darwin" ? "macOS LaunchAgent" : "systemd user"})?`,
      initialValue: true,
    });
    if (cancelled(install)) abort();

    if (install) {
      const startNow = await p.confirm({
        message: "Start the service now?",
        initialValue: true,
      });
      if (cancelled(startNow)) abort();

      const d = installUserDaemons({
        configPath: layout.configPath,
        workerBin,
        hostBin,
        env: env as NodeJS.ProcessEnv,
        start: Boolean(startNow),
      });
      daemonResult = {
        installed: d.files.length > 0,
        messages: d.messages,
      };
      for (const m of d.messages) p.log.info(m);
      if (d.started) {
        p.log.success("Services running in the background.");
      }
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────
  const nextLines = [
    `Config: ${layout.configPath}`,
    "Pair: DM the bot → acpbot pair approve <code>",
    `Agent: ${defaultAgent}`,
  ];
  if (!daemonResult?.installed) {
    nextLines.push(
      "",
      "Run manually:",
      "  terminal 1:  acpbot-host",
      "  terminal 2:  acpbot",
    );
  }
  nextLines.push("", "Telegram: /ping  then  /new", "Re-run setup: acpbot setup");

  p.note(nextLines.join("\n"), "You're set");
  p.outro("acpbot setup complete");

  return {
    configPath: layout.configPath,
    cfg,
    daemon: daemonResult,
  };
}

/** Minimal answers type still used by tests / legacy path. */
export type { SetupAnswers };
