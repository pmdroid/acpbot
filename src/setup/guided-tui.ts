/**
 * Guided TUI onboarding with @clack/prompts.
 * Safe to re-run: loads existing config.toml as defaults, only changes
 * what you pick, and preserves keys the wizard does not edit.
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
  type LoadConfigOptions,
  type ProcessConfig,
} from "../config";
import {
  detectDaemonPlatform,
  installUserDaemons,
  resolveExecutable,
} from "./daemon-install";
import {
  detectOAuthCallbackSuggestions,
  resolveOAuthSuggestPort,
  type OAuthCallbackSuggestion,
} from "./oauth-callback-detect";
import { pickDirectoryPath } from "./folder-browser";
import {
  fullDiskAccessGuidance,
  hasFullDiskAccess,
  isDarwinPlatform,
  openFullDiskAccessSettings,
} from "./macos-fda";

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

function maskSecret(s: string | undefined): string {
  if (!s?.trim()) return "(not set)";
  if (s.length <= 8) return "••••";
  return `…${s.slice(-6)}`;
}

/**
 * OAuth callback_base picker.
 * Always lists every detection row: MagicDNS, Tailscale IP, LAN IPs — never
 * hide MagicDNS just because it matches the current config value.
 */
async function promptOAuthCallbackBase(input: {
  current?: string;
  suggestions: OAuthCallbackSuggestion[];
}): Promise<string | undefined> {
  type Choice =
    | { kind: "keep"; url: string }
    | { kind: "suggest"; url: string }
    | { kind: "custom" }
    | { kind: "skip" };

  const options: Array<{ value: Choice; label: string; hint?: string }> = [];
  const current = input.current?.trim() || undefined;
  const suggestionUrls = new Set(input.suggestions.map((s) => s.url));

  // Keep current only when it is not already one of the detected options
  if (current && !suggestionUrls.has(current)) {
    options.push({
      value: { kind: "keep", url: current },
      label: `Keep current · ${current}`,
      hint: "Custom value from config.toml (not in detected list)",
    });
  }

  // Always show MagicDNS, Tailscale IP, and LAN rows (in detection order)
  for (const s of input.suggestions) {
    const isCurrent = current === s.url;
    options.push({
      value: { kind: "suggest", url: s.url },
      label: isCurrent ? `${s.label} · ${s.url}  ← current` : `${s.label} · ${s.url}`,
      hint: s.hint,
    });
  }

  options.push({
    value: { kind: "custom" },
    label: "Custom URL…",
    hint: "e.g. http://host:8788 or https://your-tunnel.example",
  });

  options.push({
    value: { kind: "skip" },
    label: current ? "Clear OAuth callback (disable)" : "Skip (no OAuth callback)",
    hint: current
      ? "Remove callback_base from config"
      : "You can still use /mcp code paste fallback",
  });

  // Prefer current match in suggestions; else MagicDNS/first; else skip
  let initialIdx = 0;
  if (current) {
    const match = options.findIndex(
      (o) =>
        (o.value.kind === "suggest" || o.value.kind === "keep") &&
        "url" in o.value &&
        o.value.url === current,
    );
    if (match >= 0) initialIdx = match;
  } else if (input.suggestions[0]) {
    const first = options.findIndex(
      (o) => o.value.kind === "suggest" && o.value.url === input.suggestions[0]!.url,
    );
    if (first >= 0) initialIdx = first;
  } else {
    initialIdx = options.findIndex((o) => o.value.kind === "skip");
    if (initialIdx < 0) initialIdx = options.length - 1;
  }

  // clack compares by value reference — use string tokens instead
  const tokens = options.map((o, i) => ({
    ...o,
    value: String(i),
  }));

  const picked = await p.select({
    message: "OAuth callback base (phone browser must reach this host)",
    options: tokens,
    initialValue: String(initialIdx),
  });
  if (cancelled(picked)) abort();

  const choice = options[Number(picked)]?.value;
  if (!choice || choice.kind === "skip") return undefined;
  if (choice.kind === "keep" || choice.kind === "suggest") return choice.url;

  const base = await p.text({
    message: "Public callback base URL",
    placeholder: "http://mac-mini.taile07e4.ts.net:8788",
    initialValue: current,
    validate: (v) => {
      const t = String(v ?? "").trim();
      if (!t) return "Enter a URL or go back and pick Skip";
      try {
        const u = new URL(t.includes("://") ? t : `http://${t}`);
        if (!u.hostname) return "URL needs a hostname";
      } catch {
        return "Invalid URL";
      }
      return undefined;
    },
  });
  if (cancelled(base)) abort();
  const trimmed = String(base).trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

/** Fields the wizard manages + optional preserved extras from an existing config. */
export type FullConfigTomlInput = {
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
  /** Preserve non-wizard fields from a prior ProcessConfig. */
  preserve?: {
    mcpEnabled?: boolean;
    oauthListenHost?: string;
    oauthListenPort?: number;
    scheduleTickMs?: number;
    skillRoots?: string[];
    agentCommandJson?: string;
    claudeAcpPkg?: string;
    codexAcpPkg?: string;
    storePath?: string;
    stateDir?: string;
    verbose?: boolean;
  };
};

/** Full config TOML from guided answers (includes speech / oauth). */
export function renderFullConfigToml(a: FullConfigTomlInput): string {
  const lines: string[] = [
    `# acpbot configuration`,
    `# Written by guided setup (${new Date().toISOString().slice(0, 10)}).`,
    `# Re-run anytime: acpbot setup  (keeps current values as defaults)`,
    ``,
    `bot_token = ${tomlString(a.botToken)}`,
    ``,
    `default_agent = ${tomlString(a.defaultAgent)}`,
    `log_level = ${tomlString(a.logLevel)}`,
    ``,
  ];

  if (a.preserve?.storePath) {
    lines.push(`store_path = ${tomlString(a.preserve.storePath)}`);
  }
  if (a.preserve?.stateDir) {
    lines.push(`state_dir = ${tomlString(a.preserve.stateDir)}`);
  }
  if (a.preserve?.storePath || a.preserve?.stateDir) lines.push(``);

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

  const mcp = a.preserve?.mcpEnabled !== false;
  lines.push(`[features]`);
  lines.push(`mcp = ${mcp}`);
  lines.push(`tts_mode = ${tomlString(a.ttsMode)}`);
  lines.push(
    `permission_mode = ${tomlString(a.permissionMode)}  # ask | bypass`,
  );
  if (a.preserve?.verbose) lines.push(`verbose = true`);
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

  if (
    a.oauthCallbackBase ||
    a.preserve?.oauthListenHost ||
    a.preserve?.oauthListenPort
  ) {
    lines.push(`[oauth]`);
    if (a.oauthCallbackBase) {
      lines.push(`callback_base = ${tomlString(a.oauthCallbackBase)}`);
    }
    if (a.preserve?.oauthListenHost) {
      lines.push(`listen_host = ${tomlString(a.preserve.oauthListenHost)}`);
    }
    if (a.preserve?.oauthListenPort != null) {
      lines.push(`listen_port = ${a.preserve.oauthListenPort}`);
    } else if (a.oauthCallbackBase) {
      lines.push(`# listen_port = 8788`);
    }
    lines.push(``);
  }

  if (a.preserve?.scheduleTickMs != null) {
    lines.push(`[schedule]`);
    lines.push(`tick_ms = ${a.preserve.scheduleTickMs}`);
    lines.push(``);
  }

  // skillRoots from config often include package/home defaults — only write
  // if the user had explicit extras beyond defaults (hard to know). Skip.

  if (
    a.preserve?.agentCommandJson ||
    a.preserve?.claudeAcpPkg ||
    a.preserve?.codexAcpPkg
  ) {
    lines.push(`[agents]`);
    if (a.preserve.claudeAcpPkg) {
      lines.push(`claude_acp_pkg = ${tomlString(a.preserve.claudeAcpPkg)}`);
    }
    if (a.preserve.codexAcpPkg) {
      lines.push(`codex_acp_pkg = ${tomlString(a.preserve.codexAcpPkg)}`);
    }
    if (a.preserve.agentCommandJson) {
      lines.push(`command_json = ${tomlString(a.preserve.agentCommandJson)}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

function preserveFromExisting(
  existing: ProcessConfig | undefined,
): FullConfigTomlInput["preserve"] {
  if (!existing) return undefined;
  return {
    ...(existing.mcpEnabled !== undefined
      ? { mcpEnabled: existing.mcpEnabled }
      : {}),
    ...(existing.oauthListenHost
      ? { oauthListenHost: existing.oauthListenHost }
      : {}),
    ...(existing.oauthListenPort !== undefined
      ? { oauthListenPort: existing.oauthListenPort }
      : {}),
    ...(existing.scheduleTickMs !== undefined
      ? { scheduleTickMs: existing.scheduleTickMs }
      : {}),
    ...(existing.agentCommandJson
      ? { agentCommandJson: existing.agentCommandJson }
      : {}),
    ...(existing.claudeAcpPkg ? { claudeAcpPkg: existing.claudeAcpPkg } : {}),
    ...(existing.codexAcpPkg ? { codexAcpPkg: existing.codexAcpPkg } : {}),
    ...(existing.verbose ? { verbose: true } : {}),
    // store_path / state_dir: leave to XDG defaults unless user hand-edited;
    // ProcessConfig always resolves them, so we do not re-emit them here.
  };
}

/**
 * Full guided TUI setup. Prefer this over the simple readline wizard.
 * Re-run anytime: existing values are pre-selected; Enter / defaults keep them.
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
    if (isPlaceholderBotToken(existing.botToken) && !existing.repos) {
      // empty scaffold — treat as first run
      if (!existsSync(layout.configPath)) existing = undefined;
    }
  } catch {
    existing = undefined;
  }

  const reconfigure = Boolean(
    existing && !isPlaceholderBotToken(existing.botToken),
  );

  console.clear?.();
  p.intro(reconfigure ? "acpbot setup (reconfigure)" : "acpbot setup");

  if (reconfigure) {
    p.note(
      [
        `Existing config: ${layout.configPath}`,
        "",
        "Current values are used as defaults.",
        "Walk each step — keep what you want, change what you don't.",
        "Keys the wizard does not ask about (schedule, agents, …) are kept.",
      ].join("\n"),
      "Reconfigure",
    );
  } else {
    p.note(
      [
        "This wizard writes ~/.config/acpbot/config.toml",
        "and can install background services on macOS or Linux.",
        "",
        "Prereqs:",
        "  • Telegram bot from @BotFather (topics in private chats)",
        "  • Agent CLI on PATH: grok · claude · codex · opencode",
        "  • Optional: OpenAI / ElevenLabs keys for voice",
        "",
        "Re-run anytime: acpbot setup",
      ].join("\n"),
      "Welcome",
    );
  }

  // ── Telegram ──────────────────────────────────────────────────────────
  p.log.step("Telegram");

  const keepToken =
    existing && !isPlaceholderBotToken(existing.botToken)
      ? existing.botToken
      : undefined;

  let botToken = keepToken ?? "";
  if (keepToken) {
    const keep = await p.confirm({
      message: `Keep bot token (…${keepToken.slice(-6)})?`,
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
    message: reconfigure
      ? `Default coding agent (current: ${existing?.defaultAgent ?? "grok-build"})`
      : "Default coding agent",
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
    message: reconfigure
      ? `Tool permission policy (current: ${existing?.permissionMode ?? "ask"})`
      : "Default tool permission policy for new sessions",
    options: [
      {
        value: "ask",
        label: "Ask (recommended)",
        hint: "Telegram approve/reject buttons for tools",
      },
      {
        value: "bypass",
        label: "Bypass",
        hint: "Auto-allow tools — use only on trusted machines",
      },
    ],
    initialValue: existing?.permissionMode ?? "ask",
  });
  if (cancelled(permSel)) abort();
  const permissionMode = String(permSel) === "bypass" ? "bypass" : "ask";

  // ── Repos ─────────────────────────────────────────────────────────────
  p.log.step("Workspace");

  const repos: Record<string, string> = { ...(existing?.repos ?? {}) };
  const repoKeys = Object.keys(repos);

  if (repoKeys.length > 0) {
    p.log.info(
      `Repos: ${repoKeys.map((k) => `${k} → ${repos[k]}`).join("; ")}`,
    );
    const repoAction = await p.select({
      message: "Workspace repos",
      options: [
        { value: "keep", label: "Keep as-is" },
        { value: "add", label: "Add another repo" },
        { value: "edit", label: "Add or replace a repo key" },
        { value: "clear", label: "Clear all repos" },
      ],
      initialValue: "keep",
    });
    if (cancelled(repoAction)) abort();
    if (repoAction === "clear") {
      for (const k of Object.keys(repos)) delete repos[k];
    }
    if (repoAction === "add" || repoAction === "edit") {
      const key = await p.text({
        message: "Repo key (short label in /new)",
        placeholder: "demo",
        initialValue: repoKeys[0] ?? "demo",
        validate: (v) => (!v?.trim() ? "Required" : undefined),
      });
      if (cancelled(key)) abort();
      const k = String(key).trim();
      const start =
        repos[k] ?? join(homeDir(env), "code");
      const picked = await pickDirectoryPath({
        message: `Folder for repo "${k}"`,
        initialPath: repos[k],
        startDir: start,
        env,
      });
      if (!picked) abort();
      repos[k] = picked;
    }
  } else {
    const addRepo = await p.confirm({
      message: "Add a workspace repo for /new?",
      initialValue: true,
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
      const k = String(key).trim();
      const picked = await pickDirectoryPath({
        message: `Folder for repo "${k}"`,
        startDir: join(homeDir(env), "code"),
        env,
      });
      if (!picked) abort();
      repos[k] = picked;
    }
  }

  // ── Speech / API keys ─────────────────────────────────────────────────
  p.log.step("Speech & API keys (optional)");

  let ttsProvider = existing?.speech?.ttsProvider ?? "auto";
  let sttProvider = existing?.speech?.sttProvider ?? "auto";
  let ttsMode = existing?.ttsMode ?? "agent";
  let openaiApiKey = existing?.speech?.openaiApiKey;
  let openaiTtsVoice = existing?.speech?.openaiTtsVoice ?? "alloy";
  let elevenlabsApiKey = existing?.speech?.elevenlabsApiKey;
  let elevenlabsVoiceId = existing?.speech?.elevenlabsVoiceId;

  const hasSpeech =
    Boolean(openaiApiKey || elevenlabsApiKey) ||
    (ttsMode !== "agent" && ttsMode !== undefined);

  const wantSpeech = await p.confirm({
    message: hasSpeech
      ? `Change speech / TTS settings? (current keys: OpenAI ${maskSecret(openaiApiKey)}, ElevenLabs ${maskSecret(elevenlabsApiKey)})`
      : "Configure TTS / STT (voice notes)?",
    initialValue: !hasSpeech,
  });
  if (cancelled(wantSpeech)) abort();

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
      if (openaiApiKey) {
        const keep = await p.confirm({
          message: `Keep OpenAI API key (${maskSecret(openaiApiKey)})?`,
          initialValue: true,
        });
        if (cancelled(keep)) abort();
        if (!keep) openaiApiKey = undefined;
      }
      if (!openaiApiKey) {
        const oai = await p.password({
          message: "OpenAI API key (optional, Enter to skip)",
        });
        if (cancelled(oai)) abort();
        if (String(oai).trim()) openaiApiKey = String(oai).trim();
      }

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
      if (elevenlabsApiKey) {
        const keep = await p.confirm({
          message: `Keep ElevenLabs API key (${maskSecret(elevenlabsApiKey)})?`,
          initialValue: true,
        });
        if (cancelled(keep)) abort();
        if (!keep) elevenlabsApiKey = undefined;
      }
      if (!elevenlabsApiKey) {
        const el = await p.password({
          message: "ElevenLabs API key (optional, Enter to skip)",
        });
        if (cancelled(el)) abort();
        if (String(el).trim()) elevenlabsApiKey = String(el).trim();
      }

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
  p.log.message(
    "Remote MCP providers redirect the browser back to this host. " +
      "Use a URL your phone can open (Tailscale MagicDNS / 100.x, or a custom tunnel).",
  );

  const oauthPort = resolveOAuthSuggestPort({
    oauthListenPort: existing?.oauthListenPort,
    oauthCallbackBase: existing?.oauthCallbackBase,
  });
  let detected: OAuthCallbackSuggestion[] = [];
  try {
    detected = detectOAuthCallbackSuggestions({ port: oauthPort });
  } catch {
    detected = [];
  }
  if (detected.length > 0) {
    p.log.info(
      `Detected: ${detected.map((d) => d.url).join(" · ")}`,
    );
  } else {
    p.log.message(
      "No Tailscale MagicDNS/IP detected (is `tailscale` installed and logged in?). " +
        "You can still enter a custom callback URL.",
    );
  }

  let oauthCallbackBase = existing?.oauthCallbackBase?.trim() || undefined;
  oauthCallbackBase = await promptOAuthCallbackBase({
    current: oauthCallbackBase,
    suggestions: detected,
  });

  // ── Log level ─────────────────────────────────────────────────────────
  const logLevel = await p.select({
    message: reconfigure
      ? `Log level (current: ${existing?.logLevel ?? "info"})`
      : "Log level",
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
  s.start(reconfigure ? "Updating config.toml" : "Writing config.toml");
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
    preserve: preserveFromExisting(existing),
  });
  writeConfigToml(layout.configPath, body);
  s.stop(`Saved ${layout.configPath}`);

  const cfg = loadConfig({
    configPath: layout.configPath,
    env,
    requireTelegram: true,
  });

  // ── macOS Full Disk Access ────────────────────────────────────────────
  const acpbotBin = resolveExecutable("acpbot", env as NodeJS.ProcessEnv);

  if (isDarwinPlatform()) {
    p.log.step("macOS Full Disk Access");
    const fdaOk = hasFullDiskAccess({
      home: homeDir(env),
    });
    if (fdaOk) {
      p.log.success(
        "Full Disk Access looks granted for this process (protected Library paths are readable).",
      );
      p.log.message(
        `If LaunchAgents still hit “Operation not permitted”, add this binary in System Settings:\n  ${acpbotBin ?? "~/.local/bin/acpbot"}`,
      );
    } else {
      p.note(
        fullDiskAccessGuidance(acpbotBin),
        "Recommended for agents on real project folders",
      );
      const openFda = await p.confirm({
        message:
          "Open System Settings → Full Disk Access so you can enable acpbot?",
        initialValue: true,
      });
      if (cancelled(openFda)) abort();
      if (openFda) {
        const opened = openFullDiskAccessSettings();
        if (opened) {
          p.log.info(
            "Opened Full Disk Access. Add acpbot, enable the toggle, then return here.",
          );
        } else {
          p.log.warn(
            "Could not open System Settings automatically.\n" +
              "  Open: System Settings → Privacy & Security → Full Disk Access",
          );
        }
        const done = await p.confirm({
          message:
            "Press Yes after enabling Full Disk Access for acpbot (or skip for now)",
          initialValue: true,
        });
        if (cancelled(done)) abort();
        if (done) {
          if (hasFullDiskAccess({ home: homeDir(env) })) {
            p.log.success("Full Disk Access detected for this process.");
          } else {
            p.log.warn(
              "Still cannot read protected paths from this process.\n" +
                "  You may have enabled the wrong app (enable the acpbot binary),\n" +
                "  or the toggle needs a service restart after setup.",
            );
          }
        }
      } else {
        p.log.message("Skipped Full Disk Access — you can enable it later in System Settings.");
      }
    }
  }

  // ── Daemon install ────────────────────────────────────────────────────
  p.log.step("Background service");

  const platform = detectDaemonPlatform();

  let daemonResult: GuidedSetupResult["daemon"];

  if (platform === "unsupported") {
    p.log.warn(
      `Daemon install not available on ${process.platform}. Run \`acpbot host\` and \`acpbot worker\` manually.`,
    );
  } else if (!acpbotBin) {
    p.log.warn(
      "acpbot not found on PATH — skip service install.\n" +
        "  Put the release binary in ~/.local/bin or /usr/local/bin, then: acpbot setup",
    );
  } else {
    const install = await p.confirm({
      message: reconfigure
        ? `Reinstall / refresh host + worker services (${platform === "darwin" ? "LaunchAgents" : "systemd"})?`
        : `Install host + worker as a background service (${platform === "darwin" ? "macOS LaunchAgent" : "systemd user"})?`,
      initialValue: !reconfigure,
    });
    if (cancelled(install)) abort();

    if (install) {
      const startNow = await p.confirm({
        message: reconfigure
          ? "Restart services now?"
          : "Start the service now?",
        initialValue: true,
      });
      if (cancelled(startNow)) abort();

      const d = installUserDaemons({
        configPath: layout.configPath,
        bin: acpbotBin,
        env: env as NodeJS.ProcessEnv,
        start: Boolean(startNow),
      });
      daemonResult = {
        installed: d.files.length > 0,
        messages: d.messages,
      };
      for (const m of d.messages) p.log.info(m);
      if (d.started) {
        p.log.success(
          reconfigure
            ? "Services refreshed."
            : "Services running in the background.",
        );
      }
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────
  const nextLines = [
    `Config: ${layout.configPath}`,
    reconfigure
      ? "Pairing unchanged (operator lives in state_dir, not config)."
      : "Pair: DM the bot → acpbot pair approve <code>",
    `Agent: ${defaultAgent}`,
    `Permissions: ${permissionMode}`,
  ];
  if (!daemonResult?.installed && !reconfigure) {
    nextLines.push(
      "",
      "Run manually:",
      "  terminal 1:  acpbot host",
      "  terminal 2:  acpbot worker",
    );
  }
  if (isDarwinPlatform()) {
    nextLines.push(
      "",
      "macOS: Full Disk Access for the acpbot binary if agents need Desktop/Documents/…",
      `  Binary: ${acpbotBin ?? "~/.local/bin/acpbot"}`,
      "  System Settings → Privacy & Security → Full Disk Access",
    );
  }
  nextLines.push(
    "",
    "Telegram: /ping  then  /new",
    "Re-run setup anytime: acpbot setup",
  );

  p.note(
    nextLines.join("\n"),
    reconfigure ? "Config updated" : "You're set",
  );
  p.outro(
    reconfigure ? "acpbot reconfigure complete" : "acpbot setup complete",
  );

  return {
    configPath: layout.configPath,
    cfg,
    daemon: daemonResult,
  };
}

/** Minimal answers type still used by tests / legacy path. */
export type { SetupAnswers };
