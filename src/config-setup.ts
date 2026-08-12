/**
 * First-run layout + interactive setup.
 *
 * Creates XDG config/data dirs and a default config.toml when missing,
 * then prompts on a TTY for bot_token and optional repo.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import {
  defaultConfigPath,
  defaultDataDir,
  defaultStateDir,
  expandHome,
  homeDir,
  loadConfig,
  normalizeAgentName,
  resolveConfigFilePath,
  resolvePath,
  type LoadConfigOptions,
  type ProcessConfig,
  configPathFromArgv,
} from "./config";
import {
  agentSelectOptions,
  listKnownAgentIds,
} from "./acp/agent-launch";

const PLACEHOLDER_TOKEN = "REPLACE_ME";

export function isPlaceholderBotToken(token: string | undefined): boolean {
  if (!token?.trim()) return true;
  const t = token.trim();
  if (t.includes(PLACEHOLDER_TOKEN)) return true;
  if (/^123456:/i.test(t) && t.length < 40) return true;
  return false;
}

/** Wizard only requires a real bot token; operator is paired via CLI (`acpbot pair approve`). */
export function configNeedsTelegramSetup(cfg: ProcessConfig): boolean {
  return isPlaceholderBotToken(cfg.botToken);
}

/** Always resolve where config should live (even if the file does not exist yet). */
export function resolveConfigWritePath(
  options: LoadConfigOptions = {},
): string {
  const env = options.env ?? process.env;
  if (options.configPath?.trim()) {
    return expandHome(options.configPath.trim(), env);
  }
  const fromArgv = configPathFromArgv(options.argv ?? process.argv);
  if (fromArgv) return expandHome(fromArgv, env);
  const fromEnv = env.ACPBOT_CONFIG?.trim() || env.TACP_CONFIG?.trim();
  if (fromEnv) return expandHome(fromEnv, env);
  return defaultConfigPath(env);
}

export function defaultConfigTomlBody(): string {
  return `# acpbot configuration
# Generated on first run. Edit anytime, then restart host + worker.
# Paths default to ~/.local/share/acpbot/ when omitted.

bot_token = "${PLACEHOLDER_TOKEN}"

default_agent = "grok-build"
log_level = "info"

# [repos]
# demo = "/absolute/path/to/repo"

[features]
mcp = true
tts_mode = "agent"

# [speech]
# tts_provider = "auto"
# stt_provider = "auto"
#
# [speech.openai]
# api_key = "sk-…"
`;
}

export type EnsureLayoutResult = {
  configPath: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  /** True if we wrote a brand-new config.toml */
  createdConfig: boolean;
  /** True if we created any missing directory */
  createdDirs: boolean;
};

/**
 * mkdir config + data + state; write default config.toml if absent.
 * Safe for host and worker (idempotent).
 */
export function ensureAcpbotLayout(
  options: LoadConfigOptions = {},
): EnsureLayoutResult {
  const env = options.env ?? process.env;
  const configPath = resolveConfigWritePath(options);
  const configDir = dirname(configPath);
  const dataDir = defaultDataDir(env);
  const stateDir = defaultStateDir(env);

  let createdDirs = false;
  for (const dir of [configDir, dataDir, stateDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      createdDirs = true;
    }
  }

  let createdConfig = false;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, defaultConfigTomlBody(), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(configPath, 0o600);
    } catch {
      /* windows / restricted FS */
    }
    createdConfig = true;
  }

  return {
    configPath,
    configDir,
    dataDir,
    stateDir,
    createdConfig,
    createdDirs,
  };
}

function tomlString(value: string): string {
  // Escape for double-quoted TOML strings
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

export type SetupAnswers = {
  botToken: string;
  defaultAgent: string;
  repoKey?: string;
  repoPath?: string;
};

export function renderConfigToml(answers: SetupAnswers): string {
  const lines = [
    `# acpbot configuration`,
    `# Written by first-run setup. Edit anytime, then restart host + worker.`,
    ``,
    `bot_token = ${tomlString(answers.botToken)}`,
    ``,
    `default_agent = ${tomlString(answers.defaultAgent)}`,
    `log_level = "info"`,
    ``,
  ];
  if (answers.repoKey && answers.repoPath) {
    lines.push(`[repos]`);
    lines.push(
      `${answers.repoKey} = ${tomlString(answers.repoPath)}`,
    );
    lines.push(``);
  } else {
    lines.push(`# [repos]`);
    lines.push(`# demo = "/absolute/path/to/repo"`);
    lines.push(``);
  }
  lines.push(`[features]`);
  lines.push(`mcp = true`);
  lines.push(`tts_mode = "agent"`);
  lines.push(``);
  return lines.join("\n");
}

export function writeConfigToml(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
  def?: string,
): Promise<string> {
  const hint = def ? ` [${def}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${hint}: `, (answer) => {
      const v = answer.trim();
      resolve(v || def || "");
    });
  });
}

export type FirstRunOptions = {
  configPath: string;
  env?: Record<string, string | undefined>;
  /** Inject for tests */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Skip interactive prompts — for tests that only write answers */
  answers?: SetupAnswers;
  /**
   * When re-running setup, seed prompts from this existing config
   * (bot token shown masked; Enter keeps current values).
   */
  existing?: ProcessConfig;
};

function maskToken(token: string): string {
  if (token.length < 12) return "••••";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/**
 * Interactive onboarding wizard (or non-interactive with `answers`).
 * Writes config.toml and returns reloaded ProcessConfig.
 *
 * Run via first boot when bot_token is missing, or explicitly:
 *   acpbot setup
 */
export async function runFirstRunSetup(
  options: FirstRunOptions,
): Promise<ProcessConfig> {
  const env = options.env ?? process.env;
  let answers = options.answers;
  const existing = options.existing;

  if (!answers) {
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stderr;
    if (!("isTTY" in stdin) || !(stdin as NodeJS.ReadStream).isTTY) {
      throw new Error(
        `Config needs setup (bot_token).\n` +
          `  Edit: ${options.configPath}\n` +
          `  Or run \`acpbot setup\` in a terminal for the onboarding wizard.`,
      );
    }

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const reconfigure = Boolean(
        existing && !isPlaceholderBotToken(existing.botToken),
      );
      stdout.write(
        `\n` +
          `┌──────────────────────────────────────────┐\n` +
          `│  acpbot  ·  onboarding                   │\n` +
          `└──────────────────────────────────────────┘\n` +
          `Config → ${options.configPath}\n` +
          (reconfigure
            ? `(Re-run: press Enter to keep a current value.)\n\n`
            : `\n`) +
          `Prereqs:\n` +
          `  • @BotFather → bot token + topics in private chats\n` +
          `  • Agent CLI on PATH (detected below)\n\n`,
      );

      let botToken = "";
      const keepToken =
        existing && !isPlaceholderBotToken(existing.botToken)
          ? existing.botToken
          : undefined;
      while (isPlaceholderBotToken(botToken)) {
        const entered = await ask(
          rl,
          keepToken
            ? `Bot token (Enter keeps ${maskToken(keepToken)})`
            : "Bot token",
        );
        botToken = entered || keepToken || "";
        if (isPlaceholderBotToken(botToken)) {
          stdout.write(
            "  Need a real token from @BotFather (looks like 123456:AA…).\n",
          );
        }
      }

      let agentPick = agentSelectOptions();
      if (agentPick.noneInstalled) {
        stdout.write(
          "\nNo agent CLIs found on PATH. Install one of:\n" +
            listKnownAgentIds()
              .map((id) => `  • ${id}`)
              .join("\n") +
            "\n\n",
        );
        const force = (
          await ask(rl, "Show all agents anyway? (y/N)", "n")
        ).toLowerCase();
        if (force === "y" || force === "yes") {
          agentPick = agentSelectOptions({ availableOnly: false });
        } else {
          throw new Error(
            "No agent CLIs on PATH. Install grok/claude/codex/opencode/cursor-agent, then re-run acpbot setup.",
          );
        }
      } else {
        stdout.write(
          `\nInstalled agents: ${agentPick.agents.join(", ")}\n`,
        );
      }
      const agentDefault =
        (existing?.defaultAgent &&
        agentPick.agents.includes(normalizeAgentName(existing.defaultAgent))
          ? normalizeAgentName(existing.defaultAgent)
          : undefined) ??
        agentPick.agents[0] ??
        "grok-build";
      const agentRaw = await ask(
        rl,
        `Default agent (${agentPick.agents.join(" | ")})`,
        agentDefault,
      );
      let defaultAgent = normalizeAgentName(agentRaw || agentDefault);
      if (!agentPick.agents.includes(defaultAgent)) {
        stdout.write(
          `  Unknown or unavailable agent \`${defaultAgent}\` — using ${agentDefault}.\n`,
        );
        defaultAgent = agentDefault;
      }

      const existingRepos = existing?.repos
        ? Object.entries(existing.repos)
        : [];
      const hasRepo = existingRepos.length > 0;
      const addRepo = (
        await ask(
          rl,
          hasRepo
            ? `Add/replace a workspace repo? (y/N)  [have: ${existingRepos.map(([k]) => k).join(", ")}]`
            : "Add a workspace repo now? (y/N)",
          "n",
        )
      ).toLowerCase();
      let repoKey: string | undefined;
      let repoPath: string | undefined;
      if (addRepo === "y" || addRepo === "yes") {
        const defKey = existingRepos[0]?.[0] ?? "demo";
        const defPath =
          existingRepos[0]?.[1] ?? join(homeDir(env), "code");
        repoKey = (await ask(rl, "Repo key (short name)", defKey)) || "demo";
        const pathRaw = await ask(rl, "Repo absolute path", defPath);
        repoPath = resolvePath(pathRaw, env);
      } else if (hasRepo && existingRepos[0]) {
        repoKey = existingRepos[0][0];
        repoPath = existingRepos[0][1];
      }

      answers = {
        botToken,
        defaultAgent,
        ...(repoKey && repoPath ? { repoKey, repoPath } : {}),
      };
      stdout.write(`\n✓ Saved ${options.configPath}\n`);
      stdout.write(
        `  Pair: DM the bot for a code, then: acpbot pair approve <code>\n`,
      );
      stdout.write(
        `\nNext:\n` +
          `  terminal 1:  acpbot host\n` +
          `  terminal 2:  acpbot worker\n` +
          `  telegram:    /ping  then  /new\n` +
          `  re-run:      acpbot setup\n\n`,
      );
    } finally {
      rl.close();
    }
  }

  writeConfigToml(options.configPath, renderConfigToml(answers!));

  return loadConfig({
    configPath: options.configPath,
    env,
    requireTelegram: true,
  });
}

/** CLI: `acpbot setup` — guided TUI (reconfigure anytime). */
export async function runSetupCommand(
  options: LoadConfigOptions = {},
): Promise<ProcessConfig> {
  // Prefer full guided TUI when stdin is a TTY.
  const interactive =
    typeof process.stdin !== "undefined" && process.stdin.isTTY === true;
  if (interactive) {
    const { runGuidedSetupTui } = await import("./setup/guided-tui");
    const result = await runGuidedSetupTui(options);
    return result.cfg;
  }
  // Non-TTY fallback: simple wizard requires answers injection or fails clearly
  const layout = ensureAcpbotLayout(options);
  const env = options.env ?? process.env;
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
  return runFirstRunSetup({
    configPath: layout.configPath,
    env,
    existing:
      existing && !isPlaceholderBotToken(existing.botToken)
        ? existing
        : undefined,
  });
}

/**
 * Ensure layout, load config, run wizard if worker needs Telegram settings.
 */
export async function loadConfigWithSetup(
  options: LoadConfigOptions & {
    /** When true (worker), may prompt for bot token / operator id */
    requireTelegram?: boolean;
    interactive?: boolean;
  } = {},
): Promise<{ cfg: ProcessConfig; layout: EnsureLayoutResult }> {
  const env = options.env ?? process.env;
  const requireTelegram = options.requireTelegram !== false;
  const interactive =
    options.interactive ??
    (typeof process.stdin !== "undefined" &&
      process.stdin.isTTY === true &&
      !options.skipFile &&
      !options.file);

  const layout = ensureAcpbotLayout(options);

  // Point discovery at the file we just may have created
  const loadOpts: LoadConfigOptions = {
    ...options,
    configPath:
      options.configPath ??
      resolveConfigFilePath({ ...options, configPath: layout.configPath }) ??
      layout.configPath,
    env,
  };
  // Prefer the ensured path when default was missing before ensure
  if (!options.configPath && !options.file && !options.skipFile) {
    loadOpts.configPath = layout.configPath;
  }

  let cfg = loadConfig({
    ...loadOpts,
    requireTelegram: false, // load partial, then check
  });

  if (requireTelegram && configNeedsTelegramSetup(cfg)) {
    if (interactive) {
      // First boot without a token → full guided TUI
      const { runGuidedSetupTui } = await import("./setup/guided-tui");
      const result = await runGuidedSetupTui({
        ...options,
        configPath: layout.configPath,
        env,
      });
      cfg = result.cfg;
    } else {
      // Ensure friendly error after creating default config
      throw new Error(
        `Config needs setup at ${layout.configPath}\n` +
          `  Set bot_token, or run \`acpbot setup\` in a terminal for the onboarding wizard.`,
      );
    }
  } else if (requireTelegram) {
    cfg = loadConfig({ ...loadOpts, requireTelegram: true });
  }

  return { cfg, layout };
}

/** True for `acpbot setup` | `acpbot init` | `acpbot --setup`. */
export function isSetupCliCommand(argv: string[] = process.argv): boolean {
  const args = argv.slice(2).filter((a) => a !== "--");
  if (args.includes("--setup") || args.includes("--init")) return true;
  const cmd = args.find((a) => !a.startsWith("-"));
  return cmd === "setup" || cmd === "init";
}
