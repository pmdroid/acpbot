/**
 * Resolve tacp agent names → stdio spawn command.
 * Small built-in registry (replaces acpx agent-registry for the agents we care about).
 *
 * Claude/Codex need the official ACP adapters (not bare `claude acp` / `codex acp`).
 * OpenCode has a native `opencode acp` command.
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
const PREFERRED_ORDER = ["grok-build", "claude", "codex", "opencode"] as const;

/**
 * Default npm package pins for ACP adapters (update when bumping adapters).
 * Override with TACP_CLAUDE_ACP_PKG / TACP_CODEX_ACP_PKG (full package@ver).
 *
 * https://github.com/agentclientprotocol/claude-agent-acp
 * https://github.com/agentclientprotocol/codex-acp
 */
export const DEFAULT_CLAUDE_ACP_PKG =
  "@agentclientprotocol/claude-agent-acp@0.64.0";
export const DEFAULT_CODEX_ACP_PKG = "@agentclientprotocol/codex-acp@1.1.7";

/**
 * Built-in launches. Override with TACP_AGENT_COMMAND_JSON:
 * {"grok-build":{"command":"grok","args":["agent","stdio"]}}
 *
 * Claude/Codex use @agentclientprotocol/* adapters via npx (same as acpx).
 */
function claudeAcpPkg(env: NodeJS.ProcessEnv = process.env): string {
  return env.TACP_CLAUDE_ACP_PKG?.trim() || DEFAULT_CLAUDE_ACP_PKG;
}

function codexAcpPkg(env: NodeJS.ProcessEnv = process.env): string {
  return env.TACP_CODEX_ACP_PKG?.trim() || DEFAULT_CODEX_ACP_PKG;
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
};

/** Normalize friendly names onto canonical ids. */
export function normalizeAgentName(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === "grok" || n === "xai" || n === "grok-build") return "grok-build";
  if (n === "claude-code" || n === "claude-acp") return "claude";
  if (n === "opencode-ai" || n === "open-code") return "opencode";
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
    return Bun.which(command) ?? null;
  }
  // Minimal PATH fallback for non-Bun hosts
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    try {
      const candidate = `${dir.replace(/\/$/, "")}/${command}`;
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

export function resolveAgentLaunch(
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentLaunch {
  const id = normalizeAgentName(agentName);
  const overrides = parseOverrides(env.TACP_AGENT_COMMAND_JSON);
  if (overrides[id]) return overrides[id]!;
  if (BUILTINS_BASE[id]) return BUILTINS_BASE[id]!.launchFor(env);

  // Last resort: treat the name as a bare binary that speaks ACP on stdio.
  return { command: agentName.trim(), args: [] };
}

/** Required binaries for a registered id (override → just the command). */
export function requiredBinsForAgent(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const id = normalizeAgentName(agentId);
  const overrides = parseOverrides(env.TACP_AGENT_COMMAND_JSON);
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
  const allow = env.TACP_AGENTS?.trim();
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
  const overrides = parseOverrides(env.TACP_AGENT_COMMAND_JSON);
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
 * Optional TACP_AGENTS=a,b,c allowlist (comma/space separated).
 *
 * Set `availableOnly: false` to skip PATH filtering (full registry).
 * Env `TACP_AGENTS_ALL=1` also lists the full registry regardless of PATH.
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
    env.TACP_AGENTS_ALL === "1" ||
    env.TACP_AGENTS_ALL === "true";

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
