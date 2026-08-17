/**
 * Guided TUI onboarding with @clack/prompts.
 * Safe to re-run: loads existing config.toml as defaults, only changes
 * what you pick, and preserves keys the wizard does not edit.
 */
import * as p from "@clack/prompts";
import { randomBytes } from "node:crypto";
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
  findTailscaleCertPair,
  resolveOAuthSuggestPort,
  stripDnsTrailingDots,
  tailscaleCertSetupHelp,
  type OAuthCallbackSuggestion,
} from "./oauth-callback-detect";
import { pickDirectoryPath } from "./folder-browser";
import {
  fullDiskAccessGuidance,
  hasFullDiskAccess,
  isDarwinPlatform,
  openFullDiskAccessSettings,
} from "./macos-fda";
import {
  agentSelectOptions,
  listKnownAgentIds,
  normalizeAgentName as normalizeAgentId,
} from "../acp/agent-launch";

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

/** Random URL-safe token for [host_listen] / remote worker auth. */
function randomHostToken(): string {
  return randomBytes(24).toString("base64url");
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
    hint: "e.g. https://host.ts.net:8788 or http://100.x:8788",
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
    placeholder: "https://your-node.ts.net:8788",
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

/**
 * Resolve TLS cert/key paths for a callback base (Tailscale MagicDNS HTTPS).
 * Shows setup help when MagicDNS HTTPS is chosen but certs are missing.
 */
function resolveOAuthTlsForCallback(input: {
  callbackBase: string | undefined;
  suggestions: OAuthCallbackSuggestion[];
  existingCert?: string;
  existingKey?: string;
  env?: NodeJS.ProcessEnv;
}): { cert?: string; key?: string; needsHelp?: string } {
  const base = input.callbackBase?.trim();
  if (!base) return {};

  let hostname = "";
  let isHttps = false;
  try {
    const u = new URL(base.includes("://") ? base : `http://${base}`);
    hostname = stripDnsTrailingDots(u.hostname);
    isHttps = u.protocol === "https:";
  } catch {
    return {};
  }

  // Plain HTTP — no TLS material
  if (!isHttps) return {};

  const matched = input.suggestions.find((s) => s.url === base);
  if (matched?.tlsCertPath && matched.tlsKeyPath) {
    return { cert: matched.tlsCertPath, key: matched.tlsKeyPath };
  }

  // MagicDNS: look under ~/.local/share/tailscale-certs/
  if (hostname.endsWith(".ts.net")) {
    const pair = findTailscaleCertPair(hostname, input.env);
    if (pair) return { cert: pair.certPath, key: pair.keyPath };
    return { needsHelp: tailscaleCertSetupHelp(hostname) };
  }

  // Custom HTTPS: keep existing explicit paths if still set
  if (input.existingCert && input.existingKey) {
    return { cert: input.existingCert, key: input.existingKey };
  }
  return {};
}

/** Workspace repo entry (path + optional multi-host binding). */
export type SetupRepoEntry = {
  path: string;
  /** Host catalog id; omit or "local" = agents on this machine. */
  hostId?: string;
};

/** Remote acp-host this worker can use for some repos. */
export type SetupRemoteHost = {
  id: string;
  url: string;
  token: string;
};

/** Accept inbound worker connections to acp-host on this machine. */
export type SetupHostListen = {
  port: number;
  host?: string;
  token: string;
};

/** Fields the wizard manages + optional preserved extras from an existing config. */
export type FullConfigTomlInput = {
  botToken: string;
  defaultAgent: string;
  logLevel: string;
  /**
   * Repos: plain path string (host=local) or `{ path, hostId }`.
   * When any hostId is non-local, TOML uses table form with `host = …`.
   */
  repos: Record<string, string | SetupRepoEntry>;
  ttsMode: string;
  permissionMode: string;
  ttsProvider: string;
  sttProvider: string;
  openaiApiKey?: string;
  openaiTtsVoice?: string;
  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  oauthCallbackBase?: string;
  /** Absolute paths written as [oauth] tls_cert / tls_key (Tailscale certs). */
  oauthTlsCert?: string;
  oauthTlsKey?: string;
  /**
   * This machine's acp-host listens for remote workers (WSS).
   * Written as [host_listen].
   */
  hostListen?: SetupHostListen;
  /**
   * Other machines' acp-host endpoints this worker can route to.
   * Written as [hosts.<id>] kind=wss.
   */
  remoteHosts?: SetupRemoteHost[];
  /** Preserve non-wizard fields from a prior ProcessConfig. */
  preserve?: {
    mcpEnabled?: boolean;
    oauthListenHost?: string;
    oauthListenPort?: number;
    oauthTlsCert?: string;
    oauthTlsKey?: string;
    scheduleTickMs?: number;
    skillRoots?: string[];
    agentCommandJson?: string;
    claudeAcpPkg?: string;
    codexAcpPkg?: string;
    storePath?: string;
    stateDir?: string;
    verbose?: boolean;
    /** Whole `[computer]` table — re-run must not drop it. */
    computer?: import("../env/types").ComputerConfig;
  };
};

function normalizeSetupRepo(v: string | SetupRepoEntry): SetupRepoEntry {
  if (typeof v === "string") return { path: v, hostId: "local" };
  return {
    path: v.path,
    hostId: v.hostId?.trim() || "local",
  };
}

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

  const repoEntries = Object.entries(a.repos).map(
    ([k, v]) => [k, normalizeSetupRepo(v)] as const,
  );
  const anyRemoteRepo = repoEntries.some(
    ([, e]) => e.hostId && e.hostId !== "local",
  );
  if (repoEntries.length > 0) {
    if (anyRemoteRepo) {
      // Table form required when binding repos to non-local hosts
      for (const [k, e] of repoEntries) {
        lines.push(`[repos.${k}]`);
        lines.push(`path = ${tomlString(e.path)}`);
        if (e.hostId && e.hostId !== "local") {
          lines.push(`host = ${tomlString(e.hostId)}`);
        }
        lines.push(``);
      }
    } else {
      lines.push(`[repos]`);
      for (const [k, e] of repoEntries) {
        lines.push(`${k} = ${tomlString(e.path)}`);
      }
      lines.push(``);
    }
  } else {
    lines.push(`# [repos]`);
    lines.push(`# demo = "/absolute/path/to/repo"`);
    lines.push(`# Or multi-host:`);
    lines.push(`# [repos.work]`);
    lines.push(`# path = "/data/work"`);
    lines.push(`# host = "studio"`);
    lines.push(``);
  }

  // Multi-host: accept inbound remote workers + outbound remote hosts
  if (a.hostListen?.token?.trim() && a.hostListen.port > 0) {
    lines.push(`[host_listen]`);
    lines.push(`port = ${a.hostListen.port}`);
    lines.push(
      `host = ${tomlString(a.hostListen.host?.trim() || "0.0.0.0")}`,
    );
    lines.push(`token = ${tomlString(a.hostListen.token.trim())}`);
    lines.push(``);
  }

  if (a.remoteHosts && a.remoteHosts.length > 0) {
    for (const h of a.remoteHosts) {
      const id = h.id.trim();
      if (!id || !h.url?.trim() || !h.token?.trim()) continue;
      lines.push(`[hosts.${id}]`);
      lines.push(`kind = "wss"`);
      lines.push(`url = ${tomlString(h.url.trim())}`);
      lines.push(`token = ${tomlString(h.token.trim())}`);
      lines.push(``);
    }
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

  const tlsCert = a.oauthTlsCert ?? a.preserve?.oauthTlsCert;
  const tlsKey = a.oauthTlsKey ?? a.preserve?.oauthTlsKey;
  if (
    a.oauthCallbackBase ||
    a.preserve?.oauthListenHost ||
    a.preserve?.oauthListenPort != null ||
    tlsCert ||
    tlsKey
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
      lines.push(`# listen_port = 8788   # same port for http and https`);
    }
    if (tlsCert) lines.push(`tls_cert = ${tomlString(tlsCert)}`);
    if (tlsKey) lines.push(`tls_key = ${tomlString(tlsKey)}`);
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

  const computer = a.preserve?.computer;
  if (computer && Object.keys(computer).length > 0) {
    lines.push(`[computer]`);
    if (computer.enabled !== undefined) {
      lines.push(`enabled = ${computer.enabled ? "true" : "false"}`);
    }
    if (computer.display) {
      lines.push(`display = ${tomlString(computer.display)}`);
    }
    if (computer.publishFrames) {
      lines.push(`publish_frames = ${tomlString(computer.publishFrames)}`);
    }
    if (computer.jpegQuality != null) {
      lines.push(`jpeg_quality = ${computer.jpegQuality}`);
    }
    if (computer.maxEdgePx != null) {
      lines.push(`max_edge_px = ${computer.maxEdgePx}`);
    }
    if (computer.maxActionsPerTurn != null) {
      lines.push(`max_actions_per_turn = ${computer.maxActionsPerTurn}`);
    }
    if (computer.minActionIntervalMs != null) {
      lines.push(`min_action_interval_ms = ${computer.minActionIntervalMs}`);
    }
    if (computer.grantTtlSec != null) {
      lines.push(`grant_ttl_sec = ${computer.grantTtlSec}`);
    }
    if (computer.watchIntervalMs != null) {
      lines.push(`watch_interval_ms = ${computer.watchIntervalMs}`);
    }
    if (computer.frameCoalesceMs != null) {
      lines.push(`frame_coalesce_ms = ${computer.frameCoalesceMs}`);
    }
    if (computer.browserChannel) {
      lines.push(`browser_channel = ${tomlString(computer.browserChannel)}`);
    }
    if (computer.browserHeadless !== undefined) {
      lines.push(
        `browser_headless = ${computer.browserHeadless ? "true" : "false"}`,
      );
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
    ...(existing.oauthTlsCert
      ? { oauthTlsCert: existing.oauthTlsCert }
      : {}),
    ...(existing.oauthTlsKey ? { oauthTlsKey: existing.oauthTlsKey } : {}),
    ...(existing.scheduleTickMs !== undefined
      ? { scheduleTickMs: existing.scheduleTickMs }
      : {}),
    ...(existing.agentCommandJson
      ? { agentCommandJson: existing.agentCommandJson }
      : {}),
    ...(existing.claudeAcpPkg ? { claudeAcpPkg: existing.claudeAcpPkg } : {}),
    ...(existing.codexAcpPkg ? { codexAcpPkg: existing.codexAcpPkg } : {}),
    ...(existing.verbose ? { verbose: true } : {}),
    ...(existing.computer ? { computer: { ...existing.computer } } : {}),
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
        "  • At least one agent CLI on PATH (detected next step)",
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

  // ── Agent (PATH-detected only) ────────────────────────────────────────
  p.log.step("Agent");

  let agentPick = agentSelectOptions();
  if (agentPick.noneInstalled) {
    const known = listKnownAgentIds();
    p.note(
      [
        "No agent CLIs found on PATH.",
        "",
        "Install at least one, then re-run setup (or show the full list):",
        ...known.map((id) => `  • ${id}`),
        "",
        "Claude and Codex also need `npx` (Node).",
      ].join("\n"),
      "No agents installed",
    );
    const showAll = await p.confirm({
      message: "Show all agents anyway? (launch will fail until the CLI is installed)",
      initialValue: false,
    });
    if (cancelled(showAll)) abort();
    if (!showAll) {
      p.cancel("Install an agent CLI, then run: acpbot setup");
      process.exit(0);
    }
    agentPick = agentSelectOptions({ availableOnly: false });
  } else {
    p.note(
      `Found on PATH: ${agentPick.agents.join(", ")}`,
      "Installed agents",
    );
  }

  const currentAgent = existing?.defaultAgent
    ? normalizeAgentId(existing.defaultAgent)
    : undefined;
  const initialAgent =
    (currentAgent && agentPick.agents.includes(currentAgent)
      ? currentAgent
      : undefined) ??
    agentPick.agents[0] ??
    "grok-build";

  if (currentAgent && !agentPick.agents.includes(currentAgent)) {
    p.log.warn(
      `Current default \`${currentAgent}\` is not among the listed agents — pick a new default.`,
    );
  }

  const agent = await p.select({
    message: reconfigure
      ? `Default coding agent (current: ${existing?.defaultAgent ?? initialAgent})`
      : "Default coding agent",
    options: agentPick.options,
    initialValue: initialAgent,
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
    "Remote MCP providers redirect the browser back to this host on port 8788. " +
      "Prefer Tailscale MagicDNS HTTPS (certs from `tailscale cert`) so the phone " +
      "opens https://your-node.ts.net:8788 on the tailnet.",
  );

  const oauthPort = resolveOAuthSuggestPort({
    oauthListenPort: existing?.oauthListenPort,
    oauthCallbackBase: existing?.oauthCallbackBase,
  });
  let detected: OAuthCallbackSuggestion[] = [];
  try {
    detected = detectOAuthCallbackSuggestions({
      port: oauthPort,
      env: env as NodeJS.ProcessEnv,
    });
  } catch {
    detected = [];
  }
  if (detected.length > 0) {
    p.log.info(
      `Detected: ${detected.map((d) => `${d.label}`).join(" · ")}`,
    );
    const missing = detected.find((d) => d.needsTailscaleCert);
    if (missing) {
      p.log.message(
        "MagicDNS HTTPS needs a local cert pair (macOS + Linux):\n" +
          "  mkdir -p ~/.local/share/tailscale-certs && cd $_ && " +
          `tailscale cert ${missing.host}`,
      );
    }
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

  const tlsResolved = resolveOAuthTlsForCallback({
    callbackBase: oauthCallbackBase,
    suggestions: detected,
    existingCert: existing?.oauthTlsCert,
    existingKey: existing?.oauthTlsKey,
    env: env as NodeJS.ProcessEnv,
  });
  if (tlsResolved.needsHelp) {
    p.note(tlsResolved.needsHelp, "Tailscale HTTPS cert setup");
    p.log.warn(
      "callback_base is https:// but cert files are missing — " +
        "run the commands above, then re-run setup or restart the host " +
        "(certs under ~/.local/share/tailscale-certs/ are auto-detected).",
    );
  } else if (tlsResolved.cert && tlsResolved.key) {
    p.log.success(
      `TLS cert ready:\n  ${tlsResolved.cert}\n  ${tlsResolved.key}`,
    );
  }

  const oauthTlsCert = tlsResolved.cert;
  const oauthTlsKey = tlsResolved.key;

  // ── Multi-host (optional) ─────────────────────────────────────────────
  // Two roles:
  //  A) This machine's acp-host accepts remote workers ([host_listen])
  //  B) This worker routes some repos to another machine's host ([hosts.*])
  p.log.step("Remote agent hosts (optional)");
  p.log.message(
    "By default agents run on this machine (local acp-host).\n" +
      "You can also: (1) let other machines connect here, and/or " +
      "(2) send some repos' agents to a remote acp-host over WSS.",
  );

  // Seed from existing config
  let hostListen: SetupHostListen | undefined =
    existing?.hostListenPort && existing?.hostListenToken
      ? {
          port: existing.hostListenPort,
          host: existing.hostListenHost ?? "0.0.0.0",
          token: existing.hostListenToken,
        }
      : undefined;

  const existingRemoteHosts: SetupRemoteHost[] = [];
  if (existing?.hostsCatalog?.hosts) {
    for (const [id, h] of Object.entries(existing.hostsCatalog.hosts)) {
      if (id === "local" || h.kind !== "wss" || !h.url || !h.token) continue;
      existingRemoteHosts.push({ id, url: h.url, token: h.token });
    }
  }
  let remoteHosts: SetupRemoteHost[] = [...existingRemoteHosts];

  // Repo → hostId map (start from catalog if present)
  const repoHostByKey: Record<string, string> = {};
  if (existing?.hostsCatalog?.repos) {
    for (const [k, b] of Object.entries(existing.hostsCatalog.repos)) {
      repoHostByKey[k] = b.hostId || "local";
    }
  }
  for (const k of Object.keys(repos)) {
    if (!repoHostByKey[k]) repoHostByKey[k] = "local";
  }

  const hasMultiHost =
    Boolean(hostListen) ||
    remoteHosts.length > 0 ||
    Object.values(repoHostByKey).some((h) => h !== "local");

  const multiHostAction = await p.select({
    message: hasMultiHost
      ? "Multi-host setup (current config has remote host settings)"
      : "Multi-host / remote acp-host",
    options: [
      {
        value: "skip",
        label: hasMultiHost ? "Keep current multi-host settings" : "Skip (local only)",
        hint: "Agents only on this machine",
      },
      {
        value: "configure",
        label: "Configure multi-host…",
        hint: "Accept remotes here and/or use a remote host for some repos",
      },
      ...(hasMultiHost
        ? [
            {
              value: "clear",
              label: "Clear multi-host (local only)",
              hint: "Remove host_listen and remote hosts",
            },
          ]
        : []),
    ],
    initialValue: "skip",
  });
  if (cancelled(multiHostAction)) abort();

  if (multiHostAction === "clear") {
    hostListen = undefined;
    remoteHosts = [];
    for (const k of Object.keys(repoHostByKey)) repoHostByKey[k] = "local";
    p.log.info("Multi-host cleared — all repos use local acp-host.");
  }

  if (multiHostAction === "configure") {
    // A) Inbound listen
    const wantListen = await p.confirm({
      message:
        "Accept remote workers on THIS machine's acp-host? (writes [host_listen])",
      initialValue: Boolean(hostListen),
    });
    if (cancelled(wantListen)) abort();

    if (wantListen) {
      const portRaw = await p.text({
        message: "Listen port for remote workers",
        placeholder: "8790",
        initialValue: String(hostListen?.port ?? 8790),
        validate: (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 1 || n > 65535) {
            return "Port must be 1–65535";
          }
          return undefined;
        },
      });
      if (cancelled(portRaw)) abort();
      const bind = await p.select({
        message: "Bind address",
        options: [
          {
            value: "0.0.0.0",
            label: "0.0.0.0 (all interfaces)",
            hint: "Needed for LAN / Tailscale / Orb VMs",
          },
          {
            value: "127.0.0.1",
            label: "127.0.0.1 (localhost only)",
            hint: "Only processes on this machine",
          },
        ],
        initialValue: hostListen?.host ?? "0.0.0.0",
      });
      if (cancelled(bind)) abort();

      let token = hostListen?.token;
      if (token) {
        const keep = await p.confirm({
          message: `Keep host token (${maskSecret(token)})?`,
          initialValue: true,
        });
        if (cancelled(keep)) abort();
        if (!keep) token = undefined;
      }
      if (!token) {
        const gen = await p.confirm({
          message: "Generate a random host token?",
          initialValue: true,
        });
        if (cancelled(gen)) abort();
        if (gen) {
          token = randomHostToken();
          p.log.success(`Generated token (save for remote workers): ${token}`);
        } else {
          const tok = await p.password({
            message: "Shared host token (workers must use the same value)",
          });
          if (cancelled(tok)) abort();
          token = String(tok).trim();
          if (!token) {
            p.log.warn("Empty token — host_listen not written.");
          }
        }
      }
      if (token) {
        hostListen = {
          port: Number(portRaw),
          host: String(bind),
          token,
        };
      } else {
        hostListen = undefined;
      }
    } else {
      hostListen = undefined;
    }

    // B) Outbound remote hosts
    const wantRemotes = await p.confirm({
      message:
        "Use a remote acp-host for some workspace repos? (writes [hosts.*])",
      initialValue: remoteHosts.length > 0,
    });
    if (cancelled(wantRemotes)) abort();

    if (wantRemotes) {
      if (remoteHosts.length > 0) {
        p.log.info(
          `Current remote hosts: ${remoteHosts.map((h) => h.id).join(", ")}`,
        );
        const remoteAction = await p.select({
          message: "Remote hosts",
          options: [
            { value: "keep", label: "Keep existing remote hosts" },
            { value: "add", label: "Add another remote host" },
            { value: "replace", label: "Replace all remote hosts" },
          ],
          initialValue: "keep",
        });
        if (cancelled(remoteAction)) abort();
        if (remoteAction === "replace") remoteHosts = [];
        if (remoteAction === "add" || remoteAction === "replace") {
          // fall through to add at least one if replace emptied
        } else {
          // keep — skip add loop unless empty
        }
        if (remoteAction === "add" || remoteAction === "replace") {
          let addMore = true;
          while (addMore) {
            const id = await p.text({
              message: "Remote host id (label)",
              placeholder: "studio",
              initialValue: "studio",
              validate: (v) => {
                const s = v?.trim() ?? "";
                if (!s) return "Required";
                if (s === "local") return 'Reserved id "local"';
                if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)) {
                  return "Use letters, numbers, _ or -";
                }
                return undefined;
              },
            });
            if (cancelled(id)) abort();
            const url = await p.text({
              message: "Remote host WebSocket URL",
              placeholder: "wss://studio.example.com:8790",
              validate: (v) => {
                const s = v?.trim() ?? "";
                if (!s) return "Required";
                if (!/^wss?:\/\//i.test(s)) {
                  return "Must start with wss:// (or ws:// for trusted LAN/Orb)";
                }
                return undefined;
              },
            });
            if (cancelled(url)) abort();
            const tok = await p.password({
              message: "Token for that host (same as its [host_listen] token)",
            });
            if (cancelled(tok)) abort();
            const tokenVal = String(tok).trim();
            if (!tokenVal) {
              p.log.warn("Empty token — host not added.");
            } else {
              const hid = String(id).trim();
              remoteHosts = remoteHosts.filter((h) => h.id !== hid);
              remoteHosts.push({
                id: hid,
                url: String(url).trim(),
                token: tokenVal,
              });
              p.log.success(`Added remote host "${hid}"`);
            }
            const more = await p.confirm({
              message: "Add another remote host?",
              initialValue: false,
            });
            if (cancelled(more)) abort();
            addMore = Boolean(more);
          }
        }
      } else {
        // first remote
        let addMore = true;
        while (addMore) {
          const id = await p.text({
            message: "Remote host id (label)",
            placeholder: "studio",
            initialValue: "studio",
            validate: (v) => {
              const s = v?.trim() ?? "";
              if (!s) return "Required";
              if (s === "local") return 'Reserved id "local"';
              if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)) {
                return "Use letters, numbers, _ or -";
              }
              return undefined;
            },
          });
          if (cancelled(id)) abort();
          const url = await p.text({
            message: "Remote host WebSocket URL",
            placeholder: "wss://studio.example.com:8790",
            validate: (v) => {
              const s = v?.trim() ?? "";
              if (!s) return "Required";
              if (!/^wss?:\/\//i.test(s)) {
                return "Must start with wss:// (or ws:// for trusted LAN/Orb)";
              }
              return undefined;
            },
          });
          if (cancelled(url)) abort();
          const tok = await p.password({
            message: "Token for that host (same as its [host_listen] token)",
          });
          if (cancelled(tok)) abort();
          const tokenVal = String(tok).trim();
          if (tokenVal) {
            remoteHosts.push({
              id: String(id).trim(),
              url: String(url).trim(),
              token: tokenVal,
            });
            p.log.success(`Added remote host "${String(id).trim()}"`);
          }
          const more = await p.confirm({
            message: "Add another remote host?",
            initialValue: false,
          });
          if (cancelled(more)) abort();
          addMore = Boolean(more);
        }
      }

      // Bind repos to hosts
      const hostChoices = [
        { value: "local", label: "local (this machine)" },
        ...remoteHosts.map((h) => ({
          value: h.id,
          label: `${h.id} · ${h.url}`,
        })),
      ];
      const repoKeysNow = Object.keys(repos);
      if (repoKeysNow.length > 0 && remoteHosts.length > 0) {
        p.log.message(
          "Which host should run agents for each workspace repo?\n" +
            "Path is the filesystem path on that host.",
        );
        for (const rk of repoKeysNow) {
          const pick = await p.select({
            message: `Host for repo "${rk}" (${repos[rk]})`,
            options: hostChoices,
            initialValue: repoHostByKey[rk] ?? "local",
          });
          if (cancelled(pick)) abort();
          repoHostByKey[rk] = String(pick);
        }
      }
    } else {
      remoteHosts = [];
      for (const k of Object.keys(repoHostByKey)) repoHostByKey[k] = "local";
    }
  }

  // Build repos map with optional host binding for TOML
  const reposForToml: Record<string, string | SetupRepoEntry> = {};
  for (const [k, path] of Object.entries(repos)) {
    const hostId = repoHostByKey[k] ?? "local";
    if (hostId !== "local") {
      reposForToml[k] = { path, hostId };
    } else {
      reposForToml[k] = path;
    }
  }

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
  // When TLS was resolved for this callback, write paths; when HTTP, drop prior TLS.
  const preserve = preserveFromExisting(existing);
  if (oauthCallbackBase && !oauthTlsCert) {
    // Explicit clear of TLS when switching to HTTP or certs missing
    if (preserve) {
      delete preserve.oauthTlsCert;
      delete preserve.oauthTlsKey;
    }
  }
  const body = renderFullConfigToml({
    botToken,
    defaultAgent,
    logLevel: String(logLevel),
    repos: reposForToml,
    ttsMode,
    permissionMode,
    ttsProvider,
    sttProvider,
    openaiApiKey,
    openaiTtsVoice,
    elevenlabsApiKey,
    elevenlabsVoiceId,
    oauthCallbackBase,
    oauthTlsCert,
    oauthTlsKey,
    ...(hostListen ? { hostListen } : {}),
    ...(remoteHosts.length > 0 ? { remoteHosts } : {}),
    preserve,
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
  if (hostListen) {
    nextLines.push(
      `Host listen: ${hostListen.host ?? "0.0.0.0"}:${hostListen.port} (token set — remote workers can connect)`,
    );
  }
  if (remoteHosts.length > 0) {
    nextLines.push(
      `Remote hosts: ${remoteHosts.map((h) => h.id).join(", ")}`,
    );
    const bound = Object.entries(repoHostByKey).filter(
      ([, h]) => h !== "local",
    );
    if (bound.length > 0) {
      nextLines.push(
        `Repo→host: ${bound.map(([k, h]) => `${k}→${h}`).join(", ")}`,
      );
    }
  }
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
