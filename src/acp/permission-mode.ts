/**
 * Tool-permission policy for ACP sessions.
 *
 * Distinct from session *mode* (plan / default / ask, Codex read-only, …):
 * this controls whether permission prompts are shown in Telegram or auto-approved.
 */

export type PermissionMode = "ask" | "always-approve";

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
    n === "always-approve" ||
    n === "always" ||
    n === "alwaysapprove" ||
    n === "bypass" ||
    n === "bypasspermissions" ||
    n === "yolo" ||
    n === "auto" ||
    n === "on" ||
    n === "true" ||
    n === "1"
  ) {
    return "always-approve";
  }
  return undefined;
}

export function permissionModeLabel(mode: PermissionMode): string {
  return mode === "always-approve" ? "always-approve" : "ask";
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
    `• \`always-approve\` — auto-allow tools (yolo; deny rules still apply in some agents)`,
    ``,
    `Commands:`,
    `• \`/permissions\` — show`,
    `• \`/permissions ask|always\` — this topic`,
    `• \`/permissions default ask|always\` — new topics only`,
  );
  return lines.join("\n");
}
