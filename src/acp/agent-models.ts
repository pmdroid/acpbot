/**
 * Canned LLM model options for agents that do not advertise ACP configOptions.
 * Applied at process spawn (e.g. grok -m <model>).
 */

export type CannedModel = {
  value: string;
  name: string;
  description?: string;
};

/**
 * Per-agent canned model list. Empty = no spawn-time model override UI
 * (rely on ACP configOptions only).
 */
const CANNED: Record<string, CannedModel[]> = {
  "grok-build": [
    {
      value: "grok-4",
      name: "Grok 4",
      description: "Default flagship (if available on your plan)",
    },
    {
      value: "grok-4-fast-reasoning",
      name: "Grok 4 Fast Reasoning",
      description: "Faster reasoning-oriented Grok 4",
    },
    {
      value: "grok-3",
      name: "Grok 3",
      description: "Previous generation",
    },
    {
      value: "grok-3-mini",
      name: "Grok 3 Mini",
      description: "Cheaper / faster mini",
    },
  ],
  // codex-acp / claude adapters may use their own ACP model options; canned
  // lists help when they don't advertise.
  codex: [
    { value: "gpt-5.2", name: "GPT-5.2" },
    { value: "gpt-5.1", name: "GPT-5.1" },
    { value: "o3", name: "o3" },
    { value: "o4-mini", name: "o4-mini" },
  ],
  claude: [
    { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { value: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { value: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  "claude-code": [
    { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { value: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { value: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  "claude-acp": [
    { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { value: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { value: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
};

/** Override via env TACP_AGENT_MODELS_JSON={"grok-build":[{"value":"…","name":"…"}]} */
function parseEnvOverrides(
  env: NodeJS.ProcessEnv,
): Record<string, CannedModel[]> {
  const raw = env.TACP_AGENT_MODELS_JSON?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, CannedModel[]> = {};
    for (const [agent, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue;
      const models: CannedModel[] = [];
      for (const item of list) {
        if (typeof item === "string") {
          models.push({ value: item, name: item });
        } else if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const value = typeof o.value === "string" ? o.value : "";
          if (!value) continue;
          models.push({
            value,
            name: typeof o.name === "string" ? o.name : value,
            ...(typeof o.description === "string"
              ? { description: o.description }
              : {}),
          });
        }
      }
      if (models.length) out[agent.trim().toLowerCase()] = models;
    }
    return out;
  } catch {
    return {};
  }
}

export function getCannedModelsForAgent(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): CannedModel[] {
  const id = agentId.trim().toLowerCase();
  const overrides = parseEnvOverrides(env);
  if (overrides[id]?.length) return overrides[id]!;
  return CANNED[id] ?? [];
}

/**
 * How to pass a selected model into the agent process at spawn.
 * Return null if the agent has no known spawn-time model flag.
 */
export function applyModelToLaunch(
  agentId: string,
  launch: { command: string; args: string[] },
  modelId: string | undefined,
): { command: string; args: string[]; env?: Record<string, string> } {
  if (!modelId?.trim()) {
    return { command: launch.command, args: [...launch.args] };
  }
  const id = agentId.trim().toLowerCase();
  const model = modelId.trim();

  // Grok Build: `grok agent stdio -m <model>`
  if (id === "grok-build" || id === "grok" || id === "xai") {
    const args = [...launch.args];
    // Insert after subcommand path: agent stdio [-m model]
    const mIdx = args.indexOf("-m");
    if (mIdx >= 0) {
      args[mIdx + 1] = model;
    } else {
      args.push("-m", model);
    }
    return { command: launch.command, args };
  }

  // Codex CLI / adapter: common -m / --model
  if (id === "codex") {
    const args = [...launch.args];
    const mIdx = args.findIndex((a) => a === "-m" || a === "--model");
    if (mIdx >= 0) {
      args[mIdx + 1] = model;
    } else {
      args.push("-m", model);
    }
    return {
      command: launch.command,
      args,
      env: { CODEX_MODEL: model },
    };
  }

  // Claude ACP adapter: env is most portable
  if (id === "claude" || id === "claude-code" || id === "claude-acp") {
    return {
      command: launch.command,
      args: [...launch.args],
      env: {
        ANTHROPIC_MODEL: model,
        CLAUDE_MODEL: model,
      },
    };
  }

  // Generic: pass as env for custom agents
  return {
    command: launch.command,
    args: [...launch.args],
    env: { TACP_AGENT_MODEL: model },
  };
}
