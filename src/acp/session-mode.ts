/**
 * Session mode helpers: pick interactive modes at create, resolve plan/build toggles.
 */

/** Normalized mode list + current id from ACP (or agent extensions). */
export type SessionModeView = {
  currentModeId?: string | undefined;
  availableModeIds: string[];
  /** Where the modes were found (for logs/tests). */
  source: "acp.modes" | "x.ai/sessionConfig" | "none";
};

/**
 * Extract session modes from ACP session/new|load payloads.
 *
 * Sources (in order):
 * 1. Standard ACP `modes: { availableModes, currentModeId }` (Codex, etc.)
 * 2. Grok Build `_meta["x.ai/sessionConfig"].options` with `category: "mode"`
 *    (high / medium / low effort — not ACP session modes)
 */
export function extractSessionModes(input: {
  modes?: unknown;
  meta?: Record<string, unknown> | null | undefined;
}): SessionModeView {
  const fromAcp = extractAcpModes(input.modes);
  if (fromAcp.availableModeIds.length > 0) {
    return { ...fromAcp, source: "acp.modes" };
  }
  const fromGrok = extractGrokSessionConfigModes(input.meta);
  if (fromGrok.availableModeIds.length > 0) {
    return { ...fromGrok, source: "x.ai/sessionConfig" };
  }
  return { availableModeIds: [], source: "none" };
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

/** Grok: effort modes under x.ai/sessionConfig (category "mode"). */
function extractGrokSessionConfigModes(
  meta: Record<string, unknown> | null | undefined,
): Omit<SessionModeView, "source"> {
  if (!meta || typeof meta !== "object") return { availableModeIds: [] };
  const sc =
    meta["x.ai/sessionConfig"] ??
    meta.sessionConfig ??
    (meta["x.ai"] as { sessionConfig?: unknown } | undefined)?.sessionConfig;
  if (!sc || typeof sc !== "object") return { availableModeIds: [] };
  const options = (sc as { options?: unknown }).options;
  if (!Array.isArray(options)) return { availableModeIds: [] };

  const modeOpts: Array<{ id: string; selected?: boolean }> = [];
  for (const item of options) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.category !== "mode") continue;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    modeOpts.push({
      id,
      ...(o.selected === true ? { selected: true } : {}),
    });
  }
  if (modeOpts.length === 0) return { availableModeIds: [] };
  const selected = modeOpts.find((o) => o.selected)?.id;
  return {
    availableModeIds: modeOpts.map((o) => o.id),
    ...(selected
      ? { currentModeId: selected }
      : { currentModeId: modeOpts[0]!.id }),
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
    lines.push("_Agent did not advertise modes — /plan and /build may no-op._");
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
    "Change: `/mode` · `/model` · `/agent` · `/plan` · `/build`",
  );
  return lines.join("\n");
}
