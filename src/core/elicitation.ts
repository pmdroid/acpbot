import {
  encodeElicitationCallback,
  keyboardFromButtons,
  newToken,
  type InlineKeyboard,
} from "./callbacks";
import { markdownToTelegramHtml } from "./markdown";

export type ElicitationOption = {
  /** Value written into form content when chosen */
  value: string;
  /** Button label */
  label: string;
};

export type ElicitationDecision =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export type ElicitationRequest = {
  sessionId: string;
  raw: unknown;
};

/**
 * Extract a human question + multiple-choice options from an ACP
 * elicitation/create payload (form mode or loose shapes agents send).
 */
export function extractElicitationChoices(raw: unknown): {
  message: string;
  fieldName: string;
  options: ElicitationOption[];
} {
  const r = raw as {
    message?: string;
    mode?: string;
    requestedSchema?: {
      type?: string;
      properties?: Record<
        string,
        {
          type?: string;
          title?: string;
          description?: string;
          enum?: unknown[];
          oneOf?: Array<{ const?: unknown; title?: string }>;
        }
      >;
      required?: string[];
    };
    // Some agents put options at the top level
    options?: Array<{ id?: string; label?: string; value?: string; name?: string }>;
  } | null;

  const message = String(r?.message ?? "The agent has a question for you.");

  // Top-level options array
  if (Array.isArray(r?.options) && r!.options!.length > 0) {
    return {
      message,
      fieldName: "choice",
      options: r!.options!.map((o, i) => ({
        value: String(o.value ?? o.id ?? o.name ?? `opt-${i}`),
        label: String(o.label ?? o.name ?? o.value ?? o.id ?? `Option ${i + 1}`),
      })),
    };
  }

  const props = r?.requestedSchema?.properties;
  if (props && typeof props === "object") {
    for (const [fieldName, schema] of Object.entries(props)) {
      if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return {
          message,
          fieldName,
          options: schema.enum.map((v, i) => ({
            value: String(v),
            label: String(v),
          })),
        };
      }
      if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
        return {
          message,
          fieldName,
          options: schema.oneOf.map((o, i) => ({
            value: String(o.const ?? `opt-${i}`),
            label: String(o.title ?? o.const ?? `Option ${i + 1}`),
          })),
        };
      }
    }
  }

  // No structured choices — operator can only decline / cancel via buttons
  return {
    message,
    fieldName: "choice",
    options: [],
  };
}

export type BuiltElicitationUi = {
  token: string;
  text: string;
  parseMode: "HTML";
  keyboard: InlineKeyboard;
  fieldName: string;
  options: ElicitationOption[];
};

export function buildElicitationUi(req: ElicitationRequest): BuiltElicitationUi {
  const { message, fieldName, options } = extractElicitationChoices(req.raw);
  const token = newToken(6);

  const body = [
    "❓ <b>Agent question</b>",
    "",
    markdownToTelegramHtml(message),
  ];
  if (options.length > 0) {
    body.push("", "<i>Tap an option:</i>");
  } else {
    body.push(
      "",
      "<i>No structured choices — reply in the topic, or decline below.</i>",
    );
  }

  const buttons = options.map((o, i) => ({
    text: truncate(o.label, 40),
    callback_data: encodeElicitationCallback(token, i),
  }));
  // Always offer a way out
  buttons.push({
    text: "Skip / decline",
    callback_data: encodeElicitationCallback(token, -1),
  });

  return {
    token,
    text: body.join("\n"),
    parseMode: "HTML",
    keyboard: keyboardFromButtons(buttons),
    fieldName,
    options,
  };
}

export type PendingElicitation = {
  token: string;
  sessionKey: string;
  chatId: number;
  messageThreadId: number;
  messageId?: number;
  fieldName: string;
  options: ElicitationOption[];
  promptText: string;
  resolve: (decision: ElicitationDecision) => void;
  settled: boolean;
};

export function createElicitationBroker() {
  const pending = new Map<string, PendingElicitation>();

  return {
    register(p: PendingElicitation) {
      pending.set(p.token, p);
    },
    get(token: string) {
      return pending.get(token);
    },
    /**
     * optionIndex -1 → decline. Otherwise accept with field content.
     */
    settle(
      token: string,
      optionIndex: number,
    ): ElicitationDecision | undefined {
      const p = pending.get(token);
      if (!p || p.settled) return undefined;
      p.settled = true;
      let decision: ElicitationDecision;
      if (optionIndex < 0 || !p.options[optionIndex]) {
        decision = { action: "decline" };
      } else {
        const opt = p.options[optionIndex]!;
        decision = {
          action: "accept",
          content: { [p.fieldName]: opt.value },
        };
      }
      p.resolve(decision);
      pending.delete(token);
      return decision;
    },
    cancelAllForSession(sessionKey: string) {
      for (const [token, p] of [...pending]) {
        if (p.sessionKey === sessionKey && !p.settled) {
          p.settled = true;
          p.resolve({ action: "cancel" });
          pending.delete(token);
        }
      }
    },
  };
}

export type ElicitationBroker = ReturnType<typeof createElicitationBroker>;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
