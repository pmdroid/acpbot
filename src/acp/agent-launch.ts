/**
 * Resolve tacp agent names → stdio spawn command.
 * Small built-in registry (replaces acpx agent-registry for the agents we care about).
 */

export type AgentLaunch = {
  command: string;
  args: string[];
};

/** Normalize friendly names onto canonical ids. */
export function normalizeAgentName(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === "grok" || n === "xai" || n === "grok-build") return "grok-build";
  return n;
}

/**
 * Built-in launches. Override with TACP_AGENT_COMMAND_JSON:
 * {"grok-build":{"command":"grok","args":["agent","stdio"]}}
 */
const BUILTINS: Record<string, AgentLaunch> = {
  "grok-build": { command: "grok", args: ["agent", "stdio"] },
  codex: { command: "codex", args: ["acp"] },
  claude: { command: "claude", args: ["acp"] },
  // Fallbacks some installs use:
  "claude-code": { command: "claude", args: ["acp"] },
  "claude-acp": { command: "claude", args: ["acp"] },
};

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
  if (BUILTINS[id]) return BUILTINS[id]!;

  // Last resort: treat the name as a bare binary that speaks ACP on stdio.
  return { command: agentName.trim(), args: [] };
}
