/**
 * Classify an EVE run result so blocked / partial work is never a "plant".
 * Also: ask option matching for host.ask + /eve answer.
 */
import { createHash } from "node:crypto";
import type { EveAskAnswer, EveAskOption, EveNodeState } from "./types";

export type EveOutcomeKind = "clean" | "blocked" | "failed" | "partial";

export type EveOutcomeItem = {
  label: string;
  summary?: string;
  status: string;
};

export type EveOutcome = {
  kind: EveOutcomeKind;
  blocked: number;
  failed: number;
  done: number;
  items: EveOutcomeItem[];
  stopOnBlocked: boolean;
};

export const DEFAULT_BLOCKED_ASK_OPTIONS: EveAskOption[] = [
  { id: "retry", label: "Keep fixing blocked work" },
  { id: "continue", label: "Continue past blocked" },
  { id: "stop", label: "Stop here" },
];

const COLLECTION_KEYS = [
  "results",
  "items",
  "tickets",
  "issues",
  "nodes",
  "blockedItems",
];

export function inspectEveOutcome(
  finalResult: unknown,
  nodes: Record<string, EveNodeState> = {},
): EveOutcome {
  const items: EveOutcomeItem[] = [];
  const seen = new Set<unknown>();
  let blockedCountHint = 0;
  let stopOnBlocked = false;
  let doneHint = 0;

  const note = (flags: {
    blockedCount?: number;
    stopOnBlocked?: boolean;
    done?: number;
  }) => {
    if (typeof flags.blockedCount === "number") {
      blockedCountHint = Math.max(blockedCountHint, flags.blockedCount);
    }
    if (flags.stopOnBlocked) stopOnBlocked = true;
    if (typeof flags.done === "number") {
      doneHint = Math.max(doneHint, flags.done);
    }
  };

  walkValue(finalResult, items, seen, note);

  let failedNodes = 0;
  let doneNodes = 0;
  for (const [key, node] of Object.entries(nodes)) {
    if (node.status === "failed") {
      failedNodes++;
      items.push({
        label: node.label || key,
        summary: node.error?.slice(0, 240),
        status: "failed",
      });
    } else if (node.status === "done") {
      doneNodes++;
    }
    if (node.result !== undefined) {
      walkValue(node.result, items, seen, note);
    }
  }

  const blockedItems = dedupeItems(items.filter((i) => i.status === "blocked"));
  const failedItems = dedupeItems(items.filter((i) => i.status === "failed"));
  const blocked = Math.max(blockedItems.length, blockedCountHint);
  const failed = Math.max(failedItems.length, failedNodes);
  const done = Math.max(
    doneHint,
    items.filter((i) => i.status === "done").length,
    doneNodes,
  );

  let kind: EveOutcomeKind = "clean";
  if (blocked > 0) kind = "blocked";
  else if (failed > 0 && done > 0) kind = "partial";
  else if (failed > 0) kind = "failed";

  return {
    kind,
    blocked,
    failed,
    done,
    items: [...blockedItems, ...failedItems].slice(0, 12),
    stopOnBlocked,
  };
}

export function hasOperatorDecision(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const d = (result as { operatorDecision?: unknown }).operatorDecision;
  return Boolean(d && typeof d === "object");
}

export function attachOperatorDecision(
  result: unknown,
  answer: EveAskAnswer,
): unknown {
  const decision = {
    id: answer.id,
    label: answer.label,
    index: answer.index,
  };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), operatorDecision: decision };
  }
  return { result: result ?? null, operatorDecision: decision };
}

export function formatEveStuckMessage(input: {
  name: string;
  runId: string;
  outcome: EveOutcome;
}): string {
  const { name, runId, outcome } = input;
  const lines = [
    `🚫 EVE stuck · **${name}** · ${outcome.blocked} blocked` +
      (outcome.failed ? ` · ${outcome.failed} failed` : ""),
  ];
  for (const item of outcome.items.slice(0, 8)) {
    const bit = item.summary ? ` — ${item.summary.slice(0, 160)}` : "";
    lines.push(`• ${item.label}${bit}`);
  }
  if (!outcome.items.length && outcome.blocked > 0) {
    lines.push("• (blocked count in result; no per-ticket detail)");
  }
  lines.push(
    "",
    "This is **not** complete. What should I do?",
    "1) Keep fixing blocked work",
    "2) Continue past blocked",
    "3) Stop here",
    "",
    `Tap a button or \`/eve answer ${runId.slice(0, 8)} 1\``,
  );
  return lines.join("\n");
}

export function formatEveCompletionNotify(input: {
  name: string;
  agentsUsed: number;
  outcome: EveOutcome;
  decision?: EveAskAnswer;
}): string {
  const { name, agentsUsed, outcome, decision } = input;
  const chose = decision ? ` · you chose: ${decision.label}` : "";
  if (outcome.kind === "clean") {
    return `🌱 EVE complete · **${name}** · agents ${agentsUsed}`;
  }
  if (outcome.kind === "blocked") {
    const head = decision
      ? `📝 EVE finished blocked · **${name}**${chose} · agents ${agentsUsed}`
      : `🚫 EVE stuck · **${name}** · ${outcome.blocked} blocked · agents ${agentsUsed}`;
    return head;
  }
  if (outcome.kind === "failed") {
    return `⚠️ EVE finished with failures · **${name}** · ${outcome.failed} failed · agents ${agentsUsed}`;
  }
  return `⚠️ EVE incomplete · **${name}** · ${outcome.done} done · ${outcome.failed} failed · agents ${agentsUsed}`;
}

export function normalizeEveAskInput(raw: unknown): {
  question: string;
  options: EveAskOption[];
} {
  if (typeof raw === "string") {
    const q = raw.trim();
    if (!q) throw new Error("host.ask requires a question");
    return { question: q, options: DEFAULT_BLOCKED_ASK_OPTIONS };
  }
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const question = String(
    obj.question ?? obj.prompt ?? obj.text ?? "",
  ).trim();
  if (!question) {
    throw new Error("host.ask requires { question, options? }");
  }
  const options = normalizeAskOptions(obj.options);
  return {
    question,
    options: options.length ? options : DEFAULT_BLOCKED_ASK_OPTIONS,
  };
}

export function normalizeAskOptions(raw: unknown): EveAskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: EveAskOption[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item === "string") {
      const label = item.trim();
      if (!label) continue;
      out.push({ id: slugOption(label, i), label });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const label = String(o.label ?? o.text ?? o.id ?? "").trim();
      if (!label) continue;
      const id = String(o.id ?? slugOption(label, i));
      const description =
        typeof o.description === "string" ? o.description : undefined;
      out.push({ id, label, ...(description ? { description } : {}) });
    }
  }
  return out.slice(0, 8);
}

export function askCacheKey(
  question: string,
  options: EveAskOption[],
): string {
  const h = createHash("sha256");
  h.update(question.trim());
  h.update("\0");
  h.update(options.map((o) => `${o.id}:${o.label}`).join("\n"));
  return h.digest("hex").slice(0, 16);
}

export function matchEveAskAnswer(
  options: EveAskOption[],
  raw: string,
): EveAskAnswer | null {
  const t = raw.trim();
  if (!t) return null;

  const asNum = Number(t);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= options.length) {
    const opt = options[asNum - 1]!;
    return { id: opt.id, label: opt.label, index: asNum - 1 };
  }
  if (Number.isInteger(asNum) && asNum >= 0 && asNum < options.length && t === String(asNum)) {
    // also accept 0-based if they typed the exact index and it isn't 1-based-ambiguous
    // skip — too confusing. only 1-based numbers.
  }

  const lower = t.toLowerCase();
  const byId = options.findIndex((o) => o.id.toLowerCase() === lower);
  if (byId >= 0) {
    const opt = options[byId]!;
    return { id: opt.id, label: opt.label, index: byId };
  }

  const exactLabel = options.findIndex((o) => o.label.toLowerCase() === lower);
  if (exactLabel >= 0) {
    const opt = options[exactLabel]!;
    return { id: opt.id, label: opt.label, index: exactLabel };
  }

  const starts = options.filter((o) =>
    o.label.toLowerCase().startsWith(lower),
  );
  if (starts.length === 1) {
    const opt = starts[0]!;
    return {
      id: opt.id,
      label: opt.label,
      index: options.indexOf(opt),
    };
  }

  const contains = options.filter(
    (o) =>
      o.label.toLowerCase().includes(lower) ||
      o.id.toLowerCase().includes(lower),
  );
  if (contains.length === 1) {
    const opt = contains[0]!;
    return {
      id: opt.id,
      label: opt.label,
      index: options.indexOf(opt),
    };
  }

  return null;
}

function slugOption(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || `opt-${index + 1}`;
}

function walkValue(
  value: unknown,
  items: EveOutcomeItem[],
  seen: Set<unknown>,
  note: (flags: {
    blockedCount?: number;
    stopOnBlocked?: boolean;
    done?: number;
  }) => void,
): void {
  if (value == null) return;
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) walkValue(item, items, seen, note);
    return;
  }

  const obj = value as Record<string, unknown>;
  const status =
    typeof obj.status === "string" ? obj.status.trim().toLowerCase() : "";

  if (status === "blocked" || status === "failed") {
    items.push({
      label: firstString(
        obj.label,
        obj.identifier,
        obj.issueId,
        obj.id,
        obj.ticket,
      ) || status,
      summary: firstString(obj.summary, obj.reason, obj.detail, obj.error),
      status,
    });
  } else if (status === "done" || status === "complete" || status === "completed") {
    items.push({
      label: firstString(obj.label, obj.identifier, obj.issueId, obj.id) || "done",
      status: "done",
    });
  }

  if (typeof obj.blocked === "number" && Number.isFinite(obj.blocked)) {
    note({ blockedCount: obj.blocked });
  }
  if (typeof obj.done === "number" && Number.isFinite(obj.done)) {
    note({ done: obj.done });
  }
  if (obj.stopOnBlocked === true) note({ stopOnBlocked: true });

  for (const key of COLLECTION_KEYS) {
    if (key in obj) walkValue(obj[key], items, seen, note);
  }
  // Scan remaining object values (shallow-ish via seen) for nested status.
  for (const [k, v] of Object.entries(obj)) {
    if (COLLECTION_KEYS.includes(k)) continue;
    if (k === "status" || k === "operatorDecision") continue;
    walkValue(v, items, seen, note);
  }
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function dedupeItems(items: EveOutcomeItem[]): EveOutcomeItem[] {
  const out: EveOutcomeItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.status}:${item.label}:${item.summary ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
