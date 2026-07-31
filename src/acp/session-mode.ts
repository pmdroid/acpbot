/**
 * Session mode helpers: pick interactive modes at create, resolve plan/build toggles.
 */

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
  const prefer = ["default", "ask", "code", "agent", "full", "edit", "build"];
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
  current?: string;
  available: string[];
}): string {
  const { current, available } = input;
  const lines = [
    `**Session mode:** \`${current ?? "unknown"}\``,
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
  launch?: { command: string; args: string[] };
  mode?: string;
  availableModes?: string[];
  cwd: string;
  threadId: number;
  chatId: number;
  mcpEnabled?: boolean;
  mcpCount?: number;
  mcpNames?: string[];
  acpHost?: boolean;
  agentSessionId?: string;
}): string {
  const launch =
    input.launch != null
      ? `${input.launch.command}${input.launch.args.length ? " " + input.launch.args.join(" ") : ""}`
      : "(unknown)";
  const lines = [
    `**Session** \`${input.sessionKey}\``,
    `Status: \`${input.status}\``,
    `Agent: \`${input.agent}\``,
    `Launch / model entry: \`${launch}\``,
    `Mode: \`${input.mode ?? "unknown"}\``,
  ];
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
    "Change mode: `/mode` (button list) · `/plan` · `/build`",
  );
  return lines.join("\n");
}
