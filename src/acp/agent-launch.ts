/**
 * Resolve acpbot agent names → stdio spawn command.
 * Small built-in registry of ACP agent launches.
 *
 * Claude/Codex/Pi need ACP adapters (not bare `claude acp` / `codex acp` / `pi acp`).
 * OpenCode has a native `opencode acp` command.
 * Cursor CLI has a native `cursor-agent acp` command.
 *
 * The agent picker only lists agents whose required binaries are on PATH
 * (no duplicates, no ghost entries for missing CLIs).
 */

import { accessSync, constants, existsSync } from "node:fs";

export type AgentLaunch = {
  command: string;
  args: string[];
};

/** Locate an executable on PATH. Injectable for tests. */
export type WhichFn = (command: string) => string | null;

export type ListAgentsOptions = {
  env?: NodeJS.ProcessEnv;
  /**
   * Resolve binaries. Defaults to Bun.which / PATH scan.
   * Return null when the command is missing.
   */
  which?: WhichFn;
  /**
   * When true (default), only list agents whose required bins exist.
   * Set false to list the full registry (tests / diagnostics).
   */
  availableOnly?: boolean;
};

type BuiltinSpec = {
  launch: AgentLaunch;
  /**
   * Binaries that must exist for this agent to appear in pickers.
   * First entry is the "primary" CLI users install.
   */
  requires: string[];
  /** Short label for Telegram pickers (canonical id still used for launch). */
  label: string;
};

/** Preferred picker order (unknown ids sort after, alpha). */
const PREFERRED_ORDER = [
  "grok-build",
  "claude",
  "codex",
  "opencode",
  "cursor-agent",
  "pi",
] as const;

/**
 * Default npm package pins for ACP adapters (update when bumping adapters).
 * Override with ACPBOT_CLAUDE_ACP_PKG / ACPBOT_CODEX_ACP_PKG / ACPBOT_PI_ACP_PKG (full package@ver).
 *
 * https://github.com/agentclientprotocol/claude-agent-acp
 * https://github.com/agentclientprotocol/codex-acp
 */
export const DEFAULT_CLAUDE_ACP_PKG =
  "@agentclientprotocol/claude-agent-acp@0.64.0";
export const DEFAULT_CODEX_ACP_PKG = "@agentclientprotocol/codex-acp@1.1.7";
export const DEFAULT_PI_ACP_PKG = "pi-acp@0.0.33";

/**
 * Built-in launches. Override with ACPBOT_AGENT_COMMAND_JSON:
 * {"grok-build":{"command":"grok","args":["agent","stdio"]}}
 *
 * Claude/Codex/Pi use ACP adapters via npx.
 */
function claudeAcpPkg(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACPBOT_CLAUDE_ACP_PKG?.trim() || DEFAULT_CLAUDE_ACP_PKG;
}

function codexAcpPkg(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACPBOT_CODEX_ACP_PKG?.trim() || DEFAULT_CODEX_ACP_PKG;
}

function piAcpPkg(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACPBOT_PI_ACP_PKG?.trim() || DEFAULT_PI_ACP_PKG;
}

const BUILTINS_BASE: Record<
  string,
  Omit<BuiltinSpec, "launch"> & {
    launchFor: (env: NodeJS.ProcessEnv) => AgentLaunch;
  }
> = {
  "grok-build": {
    launchFor: () => ({ command: "grok", args: ["agent", "stdio"] }),
    requires: ["grok"],
    label: "grok",
  },
  claude: {
    launchFor: (env) => ({
      command: "npx",
      args: ["-y", claudeAcpPkg(env)],
    }),
    // Adapter needs npx + the Claude Code CLI
    requires: ["npx", "claude"],
    label: "claude",
  },
  codex: {
    launchFor: (env) => ({
      command: "npx",
      args: ["-y", codexAcpPkg(env)],
    }),
    requires: ["npx", "codex"],
    label: "codex",
  },
  opencode: {
    launchFor: () => ({ command: "opencode", args: ["acp"] }),
    requires: ["opencode"],
    label: "opencode",
  },
  /**
   * Cursor CLI native ACP (`cursor-agent acp`). Prefer the `cursor-agent`
   * binary — bare `agent` collides with Grok's `agent` on PATH.
   * https://cursor.com/docs/cli/acp
   */
  "cursor-agent": {
    launchFor: () => ({ command: "cursor-agent", args: ["acp"] }),
    requires: ["cursor-agent"],
    label: "cursor",
  },
  pi: {
    launchFor: (env) => ({
      command: "npx",
      args: ["-y", piAcpPkg(env)],
    }),
    requires: ["npx", "pi"],
    label: "pi",
  },
};

/** Normalize friendly names onto canonical ids. */
export function normalizeAgentName(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === "grok" || n === "xai" || n === "grok-build") return "grok-build";
  if (n === "claude-code" || n === "claude-acp") return "claude";
  if (n === "opencode-ai" || n === "open-code") return "opencode";
  if (n === "cursor" || n === "cursor-cli" || n === "cursor-agent") {
    return "cursor-agent";
  }
  if (
    n === "pi" ||
    n === "pi.dev" ||
    n === "pi-dev" ||
    n === "pi-acp" ||
    n === "pi-coding-agent"
  ) {
    return "pi";
  }
  return n;
}

/** Human label for pickers/status (e.g. grok-build → grok). */
export function agentDisplayName(agentId: string): string {
  const id = normalizeAgentName(agentId);
  return BUILTINS_BASE[id]?.label ?? id;
}

export function defaultWhich(command: string): string | null {
  if (!command?.trim()) return null;
  // Bun.which is reliable when running under bun test / bun start
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const fromBun = Bun.which(command);
    if (fromBun) return fromBun;
  }
  // PATH + common user install dirs (LaunchAgents use a minimal PATH)
  const sep = process.platform === "win32" ? ";" : ":";
  const home = process.env.HOME?.trim() || "";
  const extraDirs = [
    home ? `${home}/.local/bin` : "",
    home ? `${home}/.grok/bin` : "",
    home ? `${home}/.cargo/bin` : "",
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ].filter(Boolean);
  const pathEnv = process.env.PATH ?? "";
  const dirs = [
    ...pathEnv.split(sep).filter(Boolean),
    ...extraDirs,
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    try {
      const candidate = `${dir.replace(/[\\/]$/, "")}/${command}`;
      if (existsSync(candidate)) {
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          /* not executable */
        }
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

function parseOverrides(
  raw: string | undefined,
): Record<string, AgentLaunch> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      { command?: string; args?: string[] } | string[]
    >;
    const out: Record<string, AgentLaunch> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.length > 0) {
        out[normalizeAgentName(key)] = {
          command: value[0]!,
          args: value.slice(1),
        };
      } else if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.command === "string"
      ) {
        out[normalizeAgentName(key)] = {
          command: value.command,
          args: Array.isArray(value.args) ? value.args : [],
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export type ResolveLaunchOptions = {
  /**
   * When true, inject agent-specific always-approve / yolo CLI flags
   * (e.g. Grok `agent --always-approve stdio`).
   */
  alwaysApprove?: boolean;
};

export function resolveAgentLaunch(
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
  opts?: ResolveLaunchOptions,
): AgentLaunch {
  const id = normalizeAgentName(agentName);
  const overrides = parseOverrides(env.ACPBOT_AGENT_COMMAND_JSON);
  let launch: AgentLaunch;
  if (overrides[id]) launch = { ...overrides[id]!, args: [...overrides[id]!.args] };
  else if (BUILTINS_BASE[id]) launch = BUILTINS_BASE[id]!.launchFor(env);
  else launch = { command: agentName.trim(), args: [] };

  if (opts?.alwaysApprove) {
    launch = applyAlwaysApproveArgs(id, launch);
  }
  return launch;
}

/**
 * Inject process-level always-approve flags where the agent CLI supports them.
 * Grok: `grok agent --always-approve stdio` (or insert before trailing `stdio`/`serve`).
 */
export function applyAlwaysApproveArgs(
  agentId: string,
  launch: AgentLaunch,
): AgentLaunch {
  const id = normalizeAgentName(agentId);
  const args = [...launch.args];
  if (id === "grok-build" || id === "grok") {
    if (args.some((a) => a === "--always-approve" || a === "--yolo")) {
      return { command: launch.command, args };
    }
    // Prefer: agent --always-approve stdio
    const stdioIdx = args.lastIndexOf("stdio");
    if (stdioIdx >= 0) {
      args.splice(stdioIdx, 0, "--always-approve");
    } else if (args[0] === "agent") {
      args.splice(1, 0, "--always-approve");
    } else {
      args.unshift("--always-approve");
    }
    return { command: launch.command, args };
  }
  // Claude / Codex / OpenCode: rely on host auto-approve of ACP permission
  // requests (CLI flags differ and are not standardized here).
  return { command: launch.command, args };
}

/**
 * Resolve a launch command to an absolute path for spawn().
 * Bare names (e.g. `grok`) are looked up via PATH; paths with separators
 * are returned as-is when they exist.
 */
export function resolveLaunchCommandPath(
  command: string,
  which: WhichFn = defaultWhich,
): string | null {
  const cmd = command?.trim();
  if (!cmd) return null;
  if (cmd.includes("/") || cmd.includes("\\")) {
    try {
      if (existsSync(cmd)) {
        accessSync(cmd, constants.X_OK);
        return cmd;
      }
    } catch {
      return null;
    }
    return null;
  }
  return which(cmd);
}

/** Launch with command resolved to an absolute path (throws if missing). */
export function resolveAgentLaunchForSpawn(
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
  which: WhichFn = defaultWhich,
  opts?: ResolveLaunchOptions,
): AgentLaunch {
  const launch = resolveAgentLaunch(agentName, env, opts);
  const abs = resolveLaunchCommandPath(launch.command, which);
  if (!abs) {
    throw new Error(
      `agent binary not found on PATH: "${launch.command}"\n` +
        `would run: ${launch.command} ${launch.args.join(" ")}\n` +
        `Install the CLI, start acp-host from a shell where \`which ${launch.command}\` works, ` +
        `or set ACPBOT_AGENT_COMMAND_JSON with an absolute path ` +
        `(e.g. {"grok-build":{"command":"/Users/you/.grok/bin/grok","args":["agent","stdio"]}}).`,
    );
  }
  return { command: abs, args: launch.args };
}

/** Required binaries for a registered id (override → just the command). */
export function requiredBinsForAgent(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const id = normalizeAgentName(agentId);
  const overrides = parseOverrides(env.ACPBOT_AGENT_COMMAND_JSON);
  if (overrides[id]) return [overrides[id]!.command];
  if (BUILTINS_BASE[id]) return [...BUILTINS_BASE[id]!.requires];
  return [agentId.trim()];
}

export function isAgentAvailable(
  agentId: string,
  options: { env?: NodeJS.ProcessEnv; which?: WhichFn } = {},
): boolean {
  const env = options.env ?? process.env;
  const which = options.which ?? defaultWhich;
  const bins = requiredBinsForAgent(agentId, env);
  return bins.every((bin) => which(bin) != null);
}

function parseAllowlist(env: NodeJS.ProcessEnv): Set<string> | null {
  const allow = env.ACPBOT_AGENTS?.trim();
  if (!allow) return null;
  return new Set(
    allow
      .split(/[,;\s]+/)
      .map((s) => normalizeAgentName(s))
      .filter(Boolean),
  );
}

function sortAgentIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ia = (PREFERRED_ORDER as readonly string[]).indexOf(a);
    const ib = (PREFERRED_ORDER as readonly string[]).indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/**
 * Candidate registry ids (builtins + overrides), normalized, no duplicates.
 * Does not check PATH.
 */
export function listKnownAgentIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const overrides = parseOverrides(env.ACPBOT_AGENT_COMMAND_JSON);
  const ids = new Set<string>();
  for (const key of Object.keys(BUILTINS_BASE)) {
    ids.add(normalizeAgentName(key));
  }
  for (const key of Object.keys(overrides)) {
    ids.add(normalizeAgentName(key));
  }
  return sortAgentIds([...ids]);
}

/**
 * Agents for pickers: known ids that are actually installed (PATH).
 * Optional ACPBOT_AGENTS=a,b,c allowlist (comma/space separated).
 *
 * Set `availableOnly: false` to skip PATH filtering (full registry).
 * Env `ACPBOT_AGENTS_ALL=1` also lists the full registry regardless of PATH.
 */
export function listRegisteredAgents(
  envOrOptions: NodeJS.ProcessEnv | ListAgentsOptions = process.env,
): string[] {
  const options: ListAgentsOptions =
    envOrOptions &&
    typeof envOrOptions === "object" &&
    ("env" in envOrOptions ||
      "which" in envOrOptions ||
      "availableOnly" in envOrOptions)
      ? (envOrOptions as ListAgentsOptions)
      : { env: envOrOptions as NodeJS.ProcessEnv };

  const env = options.env ?? process.env;
  const which = options.which ?? defaultWhich;
  const forceAll =
    options.availableOnly === false ||
    env.ACPBOT_AGENTS_ALL === "1" ||
    env.ACPBOT_AGENTS_ALL === "true";

  let ids = listKnownAgentIds(env);
  const allow = parseAllowlist(env);
  if (allow) {
    ids = ids.filter((id) => allow.has(id));
  }
  if (!forceAll) {
    ids = ids.filter((id) => isAgentAvailable(id, { env, which }));
  }
  return sortAgentIds(ids);
}

/** Title-case labels for setup / status (canonical id still used for launch). */
const SETUP_LABELS: Record<string, string> = {
  "grok-build": "Grok Build",
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  "cursor-agent": "Cursor Agent",
  pi: "Pi",
};

/** Human label for setup pickers (e.g. grok-build → Grok Build). */
export function agentSetupLabel(agentId: string): string {
  const id = normalizeAgentName(agentId);
  return SETUP_LABELS[id] ?? agentDisplayName(id);
}

/**
 * Select-menu options for setup / CLI: one entry per installed agent.
 * `noneInstalled` is true when PATH has no known agent CLIs (caller may
 * re-call with `availableOnly: false` after confirmation).
 */
export function agentSelectOptions(
  envOrOptions: NodeJS.ProcessEnv | ListAgentsOptions = process.env,
): {
  agents: string[];
  options: Array<{ value: string; label: string; hint: string }>;
  noneInstalled: boolean;
} {
  const options: ListAgentsOptions =
    envOrOptions &&
    typeof envOrOptions === "object" &&
    ("env" in envOrOptions ||
      "which" in envOrOptions ||
      "availableOnly" in envOrOptions)
      ? (envOrOptions as ListAgentsOptions)
      : { env: envOrOptions as NodeJS.ProcessEnv };

  const env = options.env ?? process.env;
  const agents = listRegisteredAgents(options);
  const forceAll =
    options.availableOnly === false ||
    env.ACPBOT_AGENTS_ALL === "1" ||
    env.ACPBOT_AGENTS_ALL === "true";

  return {
    agents,
    noneInstalled: agents.length === 0 && !forceAll,
    options: agents.map((id) => {
      const launch = resolveAgentLaunch(id, env);
      const cmd = [launch.command, ...launch.args].join(" ");
      const bins = requiredBinsForAgent(id, env);
      const pathHint =
        bins.length > 0
          ? bins
              .map((b) => {
                const which = options.which ?? defaultWhich;
                const abs = which(b);
                return abs ? `${b} ✓` : `${b} ✗`;
              })
              .join(" · ")
          : cmd;
      return {
        value: id,
        label: agentSetupLabel(id),
        hint: forceAll && !isAgentAvailable(id, options)
          ? `not on PATH · ${cmd}`
          : pathHint || cmd,
      };
    }),
  };
}
