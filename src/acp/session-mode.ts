/**
 * Session mode helpers: pick interactive modes at create, resolve plan/build toggles.
 *
 * Permission / agent modes:
 * 1. Codex/Claude ACP `session.modes`
 * 2. OpenCode (and similar) `configOptions` select with id/category `"mode"`
 *    (build / plan — not reasoning effort)
 *
 * Grok reasoning effort (`x.ai/sessionConfig` category "mode" → high/medium/low)
 * is **not** a session mode — see session-config + `/effort`.
 */

import {
  findModeConfigOption,
  normalizeConfigOptions,
  type SessionConfigOptionView,
} from "./session-config";

/** Normalized mode list + current id from ACP. */
export type SessionModeView = {
  currentModeId?: string | undefined;
  availableModeIds: string[];
  /** Where the modes were found (for logs/tests). */
  source: "acp.modes" | "configOptions" | "none";
};

/**
 * Extract session modes from session/new|load payloads.
 *
 * Sources (in order):
 * 1. Standard ACP `modes: { availableModes, currentModeId }` (Codex, Claude)
 * 2. configOptions select id/category `"mode"` (OpenCode build/plan)
 *
 * Grok effort levels are never treated as modes.
 */
export function extractSessionModes(input: {
  modes?: unknown;
  /** @deprecated ignored for Grok effort — use configOptions for OpenCode mode */
  meta?: Record<string, unknown> | null | undefined;
  /** ACP configOptions (OpenCode puts Session Mode here) */
  configOptions?: unknown;
}): SessionModeView {
  const fromAcp = extractAcpModes(input.modes);
  if (fromAcp.availableModeIds.length > 0) {
    return { ...fromAcp, source: "acp.modes" };
  }
  const fromCfg = extractModesFromConfigOptions(input.configOptions);
  if (fromCfg.availableModeIds.length > 0) {
    return { ...fromCfg, source: "configOptions" };
  }
  return { availableModeIds: [], source: "none" };
}

function extractModesFromConfigOptions(
  raw: unknown,
): Omit<SessionModeView, "source"> {
  // Accept raw ACP configOptions or already-normalized views.
  let list = normalizeConfigOptions(raw);
  if (list.length === 0 && Array.isArray(raw)) {
    list = raw.filter(
      (x): x is SessionConfigOptionView =>
        !!x &&
        typeof x === "object" &&
        typeof (x as SessionConfigOptionView).id === "string" &&
        Array.isArray((x as SessionConfigOptionView).options),
    );
  }
  const modeOpt = findModeConfigOption(list);
  if (!modeOpt) return { availableModeIds: [] };
  const availableModeIds = modeOpt.options.map((o) => o.value).filter(Boolean);
  if (availableModeIds.length === 0) return { availableModeIds: [] };
  let currentModeId: string | undefined;
  if (modeOpt.currentValue != null && modeOpt.currentValue !== "") {
    currentModeId = String(modeOpt.currentValue);
  }
  return {
    availableModeIds,
    ...(currentModeId !== undefined ? { currentModeId } : {}),
  };
}

function extractAcpModes(modes: unknown): Omit<SessionModeView, "source"> {
  if (!modes || typeof modes !== "object") {
    return { availableModeIds: [] };
  }
  const m = modes as Record<string, unknown>;
  const availableRaw = m.availableModes ?? m.available;
  const availableModeIds: string[] = [];
  if (Array.isArray(availableRaw)) {
    for (const item of availableRaw) {
      if (typeof item === "string" && item) {
        availableModeIds.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        const id = (item as { id?: unknown }).id;
        if (typeof id === "string" && id) availableModeIds.push(id);
      }
    }
  }
  let currentModeId: string | undefined;
  if (typeof m.currentModeId === "string" && m.currentModeId) {
    currentModeId = m.currentModeId;
  } else if (typeof m.current_mode_id === "string" && m.current_mode_id) {
    currentModeId = m.current_mode_id;
  }
  return {
    availableModeIds,
    ...(currentModeId !== undefined ? { currentModeId } : {}),
  };
}

export function pickSessionModeId(
  available: string[],
  opts?: { forceReadOnly?: boolean },
): string | undefined {
  if (available.length === 0) {
    return opts?.forceReadOnly ? "read-only" : undefined;
  }
  if (opts?.forceReadOnly) {
    const preferRo = ["read-only", "read_only", "ask", "plan", "default"];
    for (const id of preferRo) {
      if (available.includes(id)) return id;
    }
    return available[0];
  }
  // Default: permission-ask / cautious modes before full agent/build.
  const prefer = [
    "ask",
    "default",
    "read-only",
    "read_only",
    "plan",
    "code",
    "agent",
    "full",
    "edit",
    "build",
  ];
  for (const id of prefer) {
    if (available.includes(id)) return id;
  }
  const nonRo = available.find((id) => !/read.?only|plan/i.test(id));
  return nonRo ?? available[0];
}

/** @deprecated use pickSessionModeId */
export function pickReadOnlyModeId(available: string[]): string | undefined {
  return pickSessionModeId(available, { forceReadOnly: true });
}

const PLAN_LIKE = [
  "plan",
  "planning",
  "read-only",
  "read_only",
  "readonly",
  "ask",
];
const BUILD_LIKE = [
  "build",
  "code",
  "agent",
  "default",
  "full",
  "edit",
  "execute",
  "write",
  "normal",
];

export function isPlanLikeMode(modeId: string | undefined): boolean {
  if (!modeId) return false;
  const n = modeId.toLowerCase().replace(/-/g, "_");
  return PLAN_LIKE.some((p) => n === p || n.includes(p.replace(/_/g, "")));
}

export function isBuildLikeMode(modeId: string | undefined): boolean {
  if (!modeId) return false;
  if (isPlanLikeMode(modeId)) return false;
  const n = modeId.toLowerCase().replace(/-/g, "_");
  return BUILD_LIKE.some((p) => n === p || n.includes(p));
}

/** Prefer plan / planning / read-only among advertised modes. */
export function resolvePlanModeId(available: string[]): string | undefined {
  for (const id of PLAN_LIKE) {
    const hit = available.find(
      (a) => a.toLowerCase().replace(/-/g, "_") === id,
    );
    if (hit) return hit;
  }
  return available.find((a) => isPlanLikeMode(a));
}

/** Prefer build / code / agent / default among advertised modes. */
export function resolveBuildModeId(available: string[]): string | undefined {
  for (const id of BUILD_LIKE) {
    const hit = available.find(
      (a) => a.toLowerCase().replace(/-/g, "_") === id,
    );
    if (hit && !isPlanLikeMode(hit)) return hit;
  }
  return available.find((a) => !isPlanLikeMode(a));
}

/**
 * Resolve a user-facing mode token to an advertised mode id.
 * Tokens: plan | build | exact mode id (case-insensitive).
 */
export function resolveModeToken(
  token: string,
  available: string[],
): string | undefined {
  const t = token.trim().toLowerCase();
  if (!t) return undefined;
  if (t === "plan" || t === "planning" || t === "ro" || t === "read-only") {
    return resolvePlanModeId(available);
  }
  if (
    t === "build" ||
    t === "code" ||
    t === "agent" ||
    t === "exec" ||
    t === "write"
  ) {
    return resolveBuildModeId(available);
  }
  const exact = available.find((a) => a.toLowerCase() === t);
  if (exact) return exact;
  return available.find((a) => a.toLowerCase().includes(t));
}

/** Toggle: plan-like → build, otherwise → plan. */
export function togglePlanBuildModeId(
  current: string | undefined,
  available: string[],
): string | undefined {
  if (isPlanLikeMode(current)) {
    return resolveBuildModeId(available);
  }
  return resolvePlanModeId(available);
}

export function formatModeStatus(input: {
  current?: string | undefined;
  available: string[];
}): string {
  const { current, available } = input;
  const lines = [
    `**Session mode:** \`${current ?? "not advertised"}\``,
    "",
  ];
  if (available.length === 0) {
    lines.push(
      "_Agent did not advertise permission modes — /plan and /build may no-op._",
      "_Reasoning effort (when available): `/effort`._",
    );
  } else {
    lines.push("Available:");
    for (const id of available) {
      const mark = id === current ? " ← current" : "";
      const tag = isPlanLikeMode(id)
        ? " (plan-like)"
        : isBuildLikeMode(id)
          ? " (build-like)"
          : "";
      lines.push(`• \`${id}\`${tag}${mark}`);
    }
  }
  lines.push(
    "",
    "Commands: `/mode` (picker) · `/mode toggle` · `/mode <id>` · `/plan` · `/build`",
  );
  return lines.join("\n");
}

/** Session /status dump for the operator. */
export function formatSessionStatus(input: {
  sessionKey: string;
  status: string;
  agent: string;
  /** Optional human label (e.g. grok for grok-build). */
  agentLabel?: string | undefined;
  launch?: { command: string; args: string[] } | undefined;
  mode?: string | undefined;
  /** LLM model label from ACP configOptions */
  model?: string | undefined;
  /** Reasoning effort (Grok high/medium/low) */
  effort?: string | undefined;
  availableModes?: string[] | undefined;
  cwd: string;
  threadId: number;
  chatId: number;
  mcpEnabled?: boolean | undefined;
  mcpCount?: number | undefined;
  mcpNames?: string[] | undefined;
  acpHost?: boolean | undefined;
  agentSessionId?: string | undefined;
}): string {
  const launch =
    input.launch != null
      ? `${input.launch.command}${input.launch.args.length ? " " + input.launch.args.join(" ") : ""}`
      : "(unknown)";
  const agentLine =
    input.agentLabel && input.agentLabel !== input.agent
      ? `Agent: \`${input.agentLabel}\` (\`${input.agent}\`)`
      : `Agent: \`${input.agent}\``;
  const lines = [
    `**Session** \`${input.sessionKey}\``,
    `Status: \`${input.status}\``,
    agentLine,
    `Launch: \`${launch}\``,
    input.mode
      ? `Mode: \`${input.mode}\``
      : `Mode: _(not advertised — try /mode or agent CLI)_`,
  ];
  if (input.model) {
    lines.push(`Model: \`${input.model}\``);
  } else {
    lines.push(`Model: _(not advertised — try /model or agent CLI)_`);
  }
  if (input.effort) {
    lines.push(`Effort: \`${input.effort}\``);
  }
  if (input.availableModes && input.availableModes.length > 0) {
    lines.push(
      `Modes: ${input.availableModes.map((m) => (m === input.mode ? `**${m}**` : m)).join(", ")}`,
    );
  }
  lines.push(
    `Thread: \`${input.threadId}\` · chat \`${input.chatId}\``,
    `Cwd: \`${input.cwd}\``,
  );
  if (input.agentSessionId) {
    lines.push(`ACP session id: \`${input.agentSessionId}\``);
  }
  if (input.mcpEnabled === false) {
    lines.push("MCP: off");
  } else {
    const names =
      input.mcpNames && input.mcpNames.length > 0
        ? input.mcpNames.join(", ")
        : "(none listed)";
    lines.push(
      `MCP: on · ${input.mcpCount ?? 0} server(s): ${names}`,
    );
  }
  if (input.acpHost != null) {
    lines.push(`acp-host: ${input.acpHost ? "yes" : "no"}`);
  }
  lines.push(
    "",
    "Change: `/mode` · `/effort` · `/model` · `/agent` · `/plan` · `/build`",
  );
  return lines.join("\n");
}
