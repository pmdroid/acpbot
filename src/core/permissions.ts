import type { PermissionDecision, PermissionRequest } from "../env/types";
import { isPlanExitPermission } from "../acp/permission-map";
import {
  encodePermissionCallback,
  keyboardFromButtons,
  newToken,
  type InlineKeyboard,
} from "./callbacks";

export type AgentPermissionOption = {
  optionId: string;
  name: string;
  /** ACP kind when present — drives AcpPermissionDecision.outcome */
  kind?: string;
};

/**
 * Pull offered options out of the ACP raw request. Never invent allow/deny —
 * if the agent sent no options, synthesize a single cancel so the operator
 * can unblock the turn.
 */
export function extractPermissionOptions(
  raw: unknown,
): AgentPermissionOption[] {
  const r = raw as {
    options?: Array<{ optionId?: string; name?: string; kind?: string }>;
    toolCall?: { title?: string; kind?: string };
  } | null;

  const opts = r?.options;
  if (Array.isArray(opts) && opts.length > 0) {
    return opts.map((o, i) => ({
      optionId: String(o.optionId ?? `opt-${i}`),
      name: String(o.name ?? o.optionId ?? `Option ${i + 1}`),
      kind: o.kind ? String(o.kind) : undefined,
    }));
  }

  return [{ optionId: "cancel", name: "Cancel", kind: "reject_once" }];
}

export function decisionFromOption(
  option: AgentPermissionOption,
): PermissionDecision {
  const kind = (option.kind ?? "").toLowerCase();
  if (kind === "allow_once" || kind === "allow-once") {
    return { outcome: "allow_once" };
  }
  if (kind === "allow_always" || kind === "allow-always") {
    return { outcome: "allow_always" };
  }
  if (kind === "reject_always" || kind === "reject-always") {
    return { outcome: "reject_always" };
  }
  if (kind === "cancel") {
    return { outcome: "cancel" };
  }
  if (kind === "reject_once" || kind === "reject-once" || kind === "reject") {
    return { outcome: "reject_once" };
  }
  // Unknown kind: treat as reject_once rather than granting.
  const name = option.name.toLowerCase();
  if (/\ballow\b|\bapprove\b|\byes\b/.test(name) && !/always/.test(name)) {
    return { outcome: "allow_once" };
  }
  if (/always/.test(name) && /allow|approve/.test(name)) {
    return { outcome: "allow_always" };
  }
  if (/cancel/.test(name)) return { outcome: "cancel" };
  return { outcome: "reject_once" };
}

export function formatPermissionPrompt(
  req: PermissionRequest,
  options: AgentPermissionOption[],
): string {
  const raw = req.raw as {
    toolCall?: { title?: string; kind?: string; rawInput?: unknown };
    title?: string;
  } | null;
  const title =
    raw?.toolCall?.title ??
    raw?.title ??
    `Permission request (${req.toolCallId || "unknown"})`;
  // Plan exit: make the approve/reject gate obvious in Telegram.
  if (isPlanExitPermission(req.raw)) {
    return (
      `📋 <b>Plan ready</b>\n` +
      `Approve to leave plan mode and implement, or reject to stay in plan.\n` +
      `<i>${escapeHtml(String(title))}</i>`
    );
  }
  // Buttons carry options — keep body to the action title only.
  return `❓ Permission\n${title}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type BuiltPermissionUi = {
  token: string;
  text: string;
  keyboard: InlineKeyboard;
  options: AgentPermissionOption[];
};

export function buildPermissionUi(req: PermissionRequest): BuiltPermissionUi {
  const options = extractPermissionOptions(req.raw);
  const token = newToken(6);
  const buttons = options.map((o, i) => ({
    text: truncate(o.name, 40),
    callback_data: encodePermissionCallback(token, i),
  }));
  return {
    token,
    text: formatPermissionPrompt(req, options),
    keyboard: keyboardFromButtons(buttons),
    options,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export type PendingPermission = {
  token: string;
  sessionKey: string;
  chatId: number;
  messageThreadId: number;
  messageId?: number;
  options: AgentPermissionOption[];
  promptText: string;
  resolve: (decision: PermissionDecision) => void;
  settled: boolean;
};

/**
 * In-flight permission waiters. Durable records (without resolve) can be
 * rehydrated later; live resolves only exist while the process holds the turn.
 */
export function createPermissionBroker() {
  const pending = new Map<string, PendingPermission>();

  return {
    register(p: PendingPermission) {
      pending.set(p.token, p);
    },
    get(token: string) {
      return pending.get(token);
    },
    settle(
      token: string,
      optionIndex: number,
    ): PermissionDecision | undefined {
      const p = pending.get(token);
      if (!p || p.settled) return undefined;
      const option = p.options[optionIndex];
      if (!option) return undefined;
      p.settled = true;
      const decision = decisionFromOption(option);
      p.resolve(decision);
      pending.delete(token);
      return decision;
    },
    cancelAllForSession(sessionKey: string, decision: PermissionDecision) {
      for (const [token, p] of [...pending]) {
        if (p.sessionKey === sessionKey && !p.settled) {
          p.settled = true;
          p.resolve(decision);
          pending.delete(token);
        }
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}

export type PermissionBroker = ReturnType<typeof createPermissionBroker>;
