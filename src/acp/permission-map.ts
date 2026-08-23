/**
 * Map acpbot PermissionDecision → ACP RequestPermissionResponse (selected optionId).
 *
 * Also: detect Grok/Claude "exit plan mode" permission prompts so bypass
 * never auto-approves leaving plan mode without an operator click.
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

function pickByName(
  options: WirePermissionOption[],
  decision: Exclude<PermissionDecision["outcome"], "cancel">,
): WirePermissionOption | undefined {
  const allow =
    decision === "allow_once" || decision === "allow_always";
  const reject =
    decision === "reject_once" || decision === "reject_always";
  for (const o of options) {
    const name = (o.name ?? o.optionId ?? "").toLowerCase();
    if (allow && /\b(allow|approve|accept|yes|continue|implement)\b/.test(name)) {
      // Prefer "always" match for allow_always
      if (decision === "allow_always" && !/always/.test(name)) continue;
      return o;
    }
    if (allow && decision === "allow_once" && /always/.test(name)) continue;
    if (allow && /\b(allow|approve|accept|yes)\b/.test(name)) return o;
    if (reject && /\b(reject|deny|no|cancel|keep)\b/.test(name)) return o;
  }
  // allow_once: any approve-like name including ones we skipped for always
  if (allow) {
    for (const o of options) {
      const name = (o.name ?? o.optionId ?? "").toLowerCase();
      if (/\b(allow|approve|accept|yes|continue|implement)\b/.test(name)) {
        return o;
      }
    }
  }
  return undefined;
}

/**
 * True when this permission ask is the agent leaving plan mode
 * (Grok `exit_plan_mode` / "Plan: Exit" / ExitPlanMode).
 * Those must always surface to the operator — never auto-bypass.
 */
export function isPlanExitPermission(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as {
    toolCall?: {
      title?: string;
      kind?: string;
      rawInput?: unknown;
      _meta?: unknown;
    };
    toolCallId?: string;
    title?: string;
    _meta?: unknown;
  };

  const title = String(r.toolCall?.title ?? r.title ?? "").toLowerCase();
  const kind = String(r.toolCall?.kind ?? "").toLowerCase();
  const toolCallId = String(r.toolCallId ?? "").toLowerCase();

  if (
    kind.includes("exit_plan") ||
    kind === "exit-plan" ||
    kind === "exitplan"
  ) {
    return true;
  }
  if (
    title.includes("exit_plan") ||
    title.includes("exit plan") ||
    title.includes("plan: exit") ||
    title === "plan exit" ||
    title.includes("leave plan")
  ) {
    return true;
  }
  if (toolCallId.includes("exit_plan")) return true;

  const ri = r.toolCall?.rawInput;
  if (ri && typeof ri === "object") {
    const variant = String(
      (ri as { variant?: string }).variant ?? "",
    ).toLowerCase();
    if (variant === "exitplanmode" || variant.includes("exit_plan")) {
      return true;
    }
  }

  // Grok _meta.x.ai/tool
  const meta = (r.toolCall as { _meta?: Record<string, unknown> } | undefined)
    ?._meta;
  const xai = meta?.["x.ai/tool"] as { name?: string; kind?: string } | undefined;
  if (xai) {
    const n = String(xai.name ?? "").toLowerCase();
    const k = String(xai.kind ?? "").toLowerCase();
    if (n.includes("exit_plan") || k.includes("exit_plan")) return true;
  }

  return false;
}

/**
 * True when this permission ask is a computer-use tool
 * (`computer_screenshot` / click / type / …). Never auto-bypass.
 */
export function isComputerUsePermission(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as {
    toolCall?: {
      title?: string;
      kind?: string;
      name?: string;
      description?: string;
      rawInput?: unknown;
      _meta?: unknown;
    };
    toolCallId?: string;
    title?: string;
    name?: string;
    description?: string;
    toolName?: string;
  };

  const looksComputer = (s: string) => {
    if (!s) return false;
    if (
      s === "computer" ||
      s.startsWith("computer_") ||
      s.startsWith("computer/") ||
      s.includes("computer_screenshot") ||
      s.includes("computer_click") ||
      s.includes("computer_type") ||
      s.includes("computer_key") ||
      s.includes("computer_navigate") ||
      /\bcomputer[\s_-](screenshot|click|type|key|navigate|scroll|drag|move|status)\b/.test(
        s,
      )
    ) {
      return true;
    }
    // Adapter may put the MCP description in title and a UUID in toolCallId.
    return s.includes("[computer]") || s.includes("/computer");
  };

  const title = String(r.toolCall?.title ?? r.title ?? r.name ?? "").toLowerCase();
  const kind = String(r.toolCall?.kind ?? "").toLowerCase();
  const toolCallId = String(r.toolCallId ?? "").toLowerCase();
  const desc = String(
    r.toolCall?.description ?? r.description ?? "",
  ).toLowerCase();
  const mcpName = String(
    r.toolCall?.name ?? r.toolName ?? r.name ?? "",
  ).toLowerCase();

  if (
    looksComputer(title) ||
    looksComputer(kind) ||
    looksComputer(toolCallId) ||
    looksComputer(desc) ||
    looksComputer(mcpName)
  ) {
    return true;
  }

  const ri = r.toolCall?.rawInput;
  if (ri && typeof ri === "object") {
    const name = String(
      (ri as { name?: string; tool?: string }).name ??
        (ri as { tool?: string }).tool ??
        "",
    ).toLowerCase();
    if (looksComputer(name)) return true;
  }

  const meta = (r.toolCall as { _meta?: Record<string, unknown> } | undefined)
    ?._meta;
  if (meta && typeof meta === "object") {
    const xai = meta["x.ai/tool"] as { name?: string; kind?: string } | undefined;
    if (xai) {
      const n = String(xai.name ?? "").toLowerCase();
      const k = String(xai.kind ?? "").toLowerCase();
      if (looksComputer(n) || looksComputer(k)) return true;
    }
    for (const v of Object.values(meta)) {
      if (typeof v === "string" && looksComputer(v.toLowerCase())) return true;
      if (v && typeof v === "object") {
        const rec = v as { name?: string; kind?: string };
        if (looksComputer(String(rec.name ?? "").toLowerCase())) return true;
        if (looksComputer(String(rec.kind ?? "").toLowerCase())) return true;
      }
    }
  }

  return false;
}

/** Plan-exit and computer-use must always reach the operator. */
export function shouldForceAskPermission(raw: unknown): boolean {
  return isPlanExitPermission(raw) || isComputerUsePermission(raw);
}

/**
 * Unique per confirm so a recent allow cannot auto-approve the next
 * computer-use or plan-exit attempt.
 */
export function forceAskFingerprint(
  sessionKey: string,
  toolCallId: string,
  raw: unknown,
): string | undefined {
  if (isComputerUsePermission(raw)) return `computer:${sessionKey}:${toolCallId}`;
  if (isPlanExitPermission(raw)) return `plan-exit:${sessionKey}:${toolCallId}`;
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
  const byName = pickByName(opts, decision.outcome);
  if (byName) {
    return { outcome: { outcome: "selected", optionId: byName.optionId } };
  }
  // No kind/name match — if only one option, select it; else cancel.
  if (opts.length === 1) {
    return { outcome: { outcome: "selected", optionId: opts[0]!.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}
