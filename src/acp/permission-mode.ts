/**
 * Tool-permission policy for ACP sessions.
 *
 * Distinct from session *mode* (plan / default / ask, Codex read-only, …):
 * this controls whether permission prompts are shown in Telegram or auto-approved.
 *
 * Product names: **ask** | **bypass**
 */

export type PermissionMode = "ask" | "bypass";

/** Normalize user/config tokens → PermissionMode (or undefined if invalid). */
export function parsePermissionMode(
  raw: string | undefined | null,
): PermissionMode | undefined {
  if (raw == null) return undefined;
  const n = String(raw).trim().toLowerCase().replace(/[_-]+/g, "-");
  if (!n) return undefined;
  if (
    n === "ask" ||
    n === "prompt" ||
    n === "default" ||
    n === "manual" ||
    n === "off"
  ) {
    return "ask";
  }
  if (
    n === "bypass" ||
    n === "bypasspermissions" ||
    n === "always-approve" ||
    n === "always" ||
    n === "alwaysapprove" ||
    n === "yolo" ||
    n === "auto" ||
    n === "on" ||
    n === "true" ||
    n === "1"
  ) {
    return "bypass";
  }
  return undefined;
}

export function permissionModeLabel(mode: PermissionMode): string {
  return mode === "bypass" ? "bypass" : "ask";
}

export function formatPermissionStatus(input: {
  session?: PermissionMode | undefined;
  defaultMode: PermissionMode;
}): string {
  const def = permissionModeLabel(input.defaultMode);
  const lines = [
    `**Permissions**`,
    ``,
    `Default (new topics): \`${def}\``,
  ];
  if (input.session) {
    lines.push(`This topic: \`${permissionModeLabel(input.session)}\``);
  } else {
    lines.push(`This topic: _(follows default — \`${def}\`)_`);
  }
  lines.push(
    ``,
    `• \`ask\` — Telegram approve / reject on each tool (safe default)`,
    `• \`bypass\` — auto-allow tools (deny rules / hooks may still apply)`,
    ``,
    `Commands:`,
    `• \`/permissions\` — status + **Ask** / **Bypass** buttons`,
    `• \`/permissions ask|bypass\` — this topic`,
    `• \`/permissions default ask|bypass\` — new topics (writes config.toml)`,
  );
  return lines.join("\n");
}

/** Inline keyboard labels for the ask|bypass picker (index 0/1). */
export const PERMISSION_MODE_OPTIONS: readonly {
  mode: PermissionMode;
  label: string;
}[] = [
  { mode: "ask", label: "Ask" },
  { mode: "bypass", label: "Bypass" },
] as const;
