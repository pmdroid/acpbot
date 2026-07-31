/**
 * Grok Build `ask_user_question` / `_x.ai/ask_user_question` multi-choice UI.
 * Input shape (from live logs):
 * {
 *   questions: [{ question, header?, options: [{ label, description? }], multiSelect? }],
 *   variant?: "AskUserQuestion"
 * }
 */

import {
  encodeAskQuestionCallback,
  keyboardFromButtons,
  newToken,
  type InlineKeyboard,
} from "./callbacks";
import { markdownToTelegramHtml } from "./markdown";

export type AskOption = {
  label: string;
  description?: string;
};

export type AskQuestion = {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
};

export type AskUserQuestionRequest = {
  sessionId: string;
  raw: unknown;
};

export function parseAskUserQuestions(raw: unknown): AskQuestion[] {
  const r = raw as {
    questions?: Array<{
      question?: string;
      header?: string;
      multiSelect?: boolean;
      multi_select?: boolean;
      options?: Array<{
        label?: string;
        description?: string;
        id?: string;
      }>;
    }>;
  } | null;

  if (!Array.isArray(r?.questions)) return [];

  return r.questions
    .map((q) => ({
      question: String(q.question ?? "").trim(),
      header: q.header ? String(q.header) : undefined,
      multiSelect: Boolean(q.multiSelect ?? q.multi_select),
      options: (q.options ?? []).map((o) => ({
        label: String(o.label ?? o.id ?? "option"),
        description: o.description ? String(o.description) : undefined,
      })),
    }))
    .filter((q) => q.question.length > 0 && q.options.length > 0);
}

export type BuiltAskUi = {
  token: string;
  questionIndex: number;
  total: number;
  text: string;
  parseMode: "HTML";
  keyboard: InlineKeyboard;
  question: AskQuestion;
};

export function buildAskQuestionUi(
  token: string,
  questionIndex: number,
  total: number,
  question: AskQuestion,
  selectedLabels: Set<string> = new Set(),
): BuiltAskUi {
  const lines = [
    total > 1
      ? `❓ <b>Question ${questionIndex + 1}/${total}</b>`
      : "❓ <b>Agent question</b>",
  ];
  if (question.header) {
    lines.push(`<i>${markdownToTelegramHtml(question.header)}</i>`);
  }
  lines.push("", markdownToTelegramHtml(question.question));

  if (question.multiSelect) {
    lines.push(
      "",
      "<i>Multi-select: tap options to toggle, then Done.</i>",
    );
    if (selectedLabels.size > 0) {
      lines.push(
        `Selected: ${[...selectedLabels].map((s) => escape(s)).join(", ")}`,
      );
    }
  } else {
    lines.push("", "<i>Tap one option:</i>");
  }

  const buttons = question.options.map((o, i) => {
    const on = selectedLabels.has(o.label);
    const prefix = question.multiSelect ? (on ? "✓ " : "○ ") : "";
    return {
      text: truncate(`${prefix}${o.label}`, 40),
      callback_data: encodeAskQuestionCallback(token, questionIndex, i),
    };
  });

  if (question.multiSelect) {
    buttons.push({
      text: "Done",
      callback_data: encodeAskQuestionCallback(token, questionIndex, -2),
    });
  }
  buttons.push({
    text: "Skip",
    callback_data: encodeAskQuestionCallback(token, questionIndex, -1),
  });

  return {
    token,
    questionIndex,
    total,
    text: lines.join("\n"),
    parseMode: "HTML",
    keyboard: keyboardFromButtons(buttons),
    question,
  };
}

export type AskAnswers = {
  answers: Array<{
    question: string;
    /** When present, used as the key in the Grok id-keyed answers map. */
    header?: string;
    selectedOptions: string[];
  }>;
};

/**
 * Grok ACP ext result: internally tagged enum `AskUserQuestionExtResponse`
 * (tag field `outcome`). Variants from the grok binary:
 * - accepted { answers, partial_answers }
 * - chat_about_this
 * - skip_interview
 *
 * `answers` is id-keyed (header preferred, else question text) → selected
 * label(s), comma-joined for multi-select — matches format_id_keyed_accepted.
 */
export function toAskUserQuestionExtResponse(
  result: AskAnswers,
  opts?: { declined?: boolean },
): Record<string, unknown> {
  const allEmpty =
    result.answers.length === 0 ||
    result.answers.every((a) => a.selectedOptions.length === 0);
  if (opts?.declined || allEmpty) {
    return { outcome: "skip_interview" };
  }

  const answers: Record<string, string> = {};
  for (const a of result.answers) {
    const key = (a.header?.trim() || a.question).trim();
    if (!key) continue;
    answers[key] = a.selectedOptions.join(", ");
  }

  return {
    outcome: "accepted",
    answers,
    // Required field on Accepted; empty when every question was fully settled.
    partial_answers: {},
  };
}

export type PendingAskSession = {
  token: string;
  sessionKey: string;
  chatId: number;
  messageThreadId: number;
  questions: AskQuestion[];
  /** answers[i] = selected labels for question i */
  answers: string[][];
  currentIndex: number;
  messageId?: number;
  /** multi-select toggles for current question */
  selected: Set<string>;
  resolve: (result: AskAnswers) => void;
  settled: boolean;
};

export function createAskUserQuestionBroker() {
  const pending = new Map<string, PendingAskSession>();

  return {
    register(p: PendingAskSession) {
      pending.set(p.token, p);
    },
    get(token: string) {
      return pending.get(token);
    },
    /**
     * Handle a button press. Returns:
     * - { kind: "progress", ui } when moving to next question or refreshing multi-select
     * - { kind: "done", result } when all questions answered
     * - undefined if invalid/settled
     */
    handleOption(
      token: string,
      questionIndex: number,
      optionIndex: number,
    ):
      | { kind: "progress"; ui: BuiltAskUi }
      | { kind: "done"; result: AskAnswers }
      | undefined {
      const p = pending.get(token);
      if (!p || p.settled) return undefined;
      if (questionIndex !== p.currentIndex) return undefined;

      const q = p.questions[questionIndex];
      if (!q) return undefined;

      // Skip question
      if (optionIndex === -1) {
        p.answers[questionIndex] = [];
        return advance(p);
      }

      // Multi-select Done
      if (optionIndex === -2) {
        p.answers[questionIndex] = [...p.selected];
        p.selected = new Set();
        return advance(p);
      }

      const opt = q.options[optionIndex];
      if (!opt) return undefined;

      if (q.multiSelect) {
        if (p.selected.has(opt.label)) p.selected.delete(opt.label);
        else p.selected.add(opt.label);
        return {
          kind: "progress",
          ui: buildAskQuestionUi(
            p.token,
            questionIndex,
            p.questions.length,
            q,
            p.selected,
          ),
        };
      }

      // Single select → record and advance
      p.answers[questionIndex] = [opt.label];
      return advance(p);
    },
    cancelAllForSession(sessionKey: string) {
      for (const [token, p] of [...pending]) {
        if (p.sessionKey === sessionKey && !p.settled) {
          p.settled = true;
          // Empty answers = declined
          p.resolve({
            answers: p.questions.map((q) => ({
              question: q.question,
              header: q.header,
              selectedOptions: [],
            })),
          });
          pending.delete(token);
        }
      }
    },
  };

  function advance(
    p: PendingAskSession,
  ):
    | { kind: "progress"; ui: BuiltAskUi }
    | { kind: "done"; result: AskAnswers } {
    const next = p.currentIndex + 1;
    if (next >= p.questions.length) {
      p.settled = true;
      const result: AskAnswers = {
        answers: p.questions.map((q, i) => ({
          question: q.question,
          header: q.header,
          selectedOptions: p.answers[i] ?? [],
        })),
      };
      p.resolve(result);
      pending.delete(p.token);
      return { kind: "done", result };
    }
    p.currentIndex = next;
    p.selected = new Set();
    const nq = p.questions[next]!;
    return {
      kind: "progress",
      ui: buildAskQuestionUi(p.token, next, p.questions.length, nq),
    };
  }
}

export type AskUserQuestionBroker = ReturnType<
  typeof createAskUserQuestionBroker
>;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** New opaque token for a multi-question session. */
export function newAskToken(): string {
  return newToken(6);
}
