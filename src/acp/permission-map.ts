/**
 * Map tacp PermissionDecision → ACP RequestPermissionResponse (selected optionId).
 */
import type { PermissionDecision } from "../env/types";

export type WirePermissionOption = {
  optionId: string;
  kind?: string;
  name?: string;
};

export type WirePermissionResponse =
  | { outcome: { outcome: "cancelled" } }
  | { outcome: { outcome: "selected"; optionId: string } };

const FALLBACK: Record<
  Exclude<PermissionDecision["outcome"], "cancel">,
  string[]
> = {
  allow_once: ["allow_once", "allow_always"],
  allow_always: ["allow_always", "allow_once"],
  reject_once: ["reject_once", "reject_always"],
  reject_always: ["reject_always", "reject_once"],
};

function pickOption(
  options: WirePermissionOption[],
  kinds: string[],
): WirePermissionOption | undefined {
  for (const kind of kinds) {
    const hit = options.find(
      (o) => (o.kind ?? "").toLowerCase().replace(/-/g, "_") === kind,
    );
    if (hit) return hit;
  }
  return undefined;
}

export function decisionToPermissionResponse(
  options: WirePermissionOption[] | undefined,
  decision: PermissionDecision | undefined,
): WirePermissionResponse {
  if (!decision || decision.outcome === "cancel") {
    return { outcome: { outcome: "cancelled" } };
  }
  const opts = options ?? [];
  const matched = pickOption(opts, FALLBACK[decision.outcome]);
  if (matched) {
    return { outcome: { outcome: "selected", optionId: matched.optionId } };
  }
  // No kind match — if only one option, select it; else cancel.
  if (opts.length === 1) {
    return { outcome: { outcome: "selected", optionId: opts[0]!.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}
