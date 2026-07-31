import { describe, expect, test } from "bun:test";
import {
  encodeAskQuestionCallback,
  parseAskQuestionCallback,
} from "../src/core/callbacks";
import { createDaemon } from "../src/core/daemon";
import {
  buildAskQuestionUi,
  parseAskUserQuestions,
  toAskUserQuestionExtResponse,
} from "../src/core/ask-user-question";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";

const OPERATOR = 42;
const CHAT = 1000;

function root(text: string, id: number): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      text,
      from: { id: OPERATOR, first_name: "op" },
      chat: { id: CHAT, type: "private" },
    },
  };
}

function callback(
  data: string,
  id: number,
  messageId: number,
  threadId: number,
): TelegramUpdate {
  return {
    update_id: id,
    callback_query: {
      id: `cq-${id}`,
      from: { id: OPERATOR, first_name: "op" },
      data,
      message: {
        message_id: messageId,
        date: 0,
        chat: { id: CHAT, type: "private" },
        message_thread_id: threadId,
        is_topic_message: true,
      },
    },
  };
}

async function settle(ms = 20): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await Bun.sleep(ms);
}

describe("Grok ask_user_question → Telegram multi-choice", () => {
  test("parses questions from tool payload", () => {
    const qs = parseAskUserQuestions({
      questions: [
        {
          question: "What next?",
          options: [
            { label: "persist", description: "localStorage" },
            { label: "pomodoro" },
          ],
        },
      ],
    });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.options.map((o) => o.label)).toEqual([
      "persist",
      "pomodoro",
    ]);
  });

  test("callback encoding under 64 bytes", () => {
    const d = encodeAskQuestionCallback("aabbcc", 0, 2);
    expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(64);
    expect(parseAskQuestionCallback(d)).toEqual({
      token: "aabbcc",
      questionIndex: 0,
      optionIndex: 2,
    });
  });

  test("round-trip two questions with buttons", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo Init", 1));
    const session = (await daemon.listSessions())[0]!;
    env.telegram.clearOutbound();

    const promise = env.agents.raiseAskUserQuestion({
      sessionId: "demo/Init",
      raw: {
        questions: [
          {
            question: "What should we build?",
            options: [
              { label: "persist" },
              { label: "pomodoro" },
            ],
          },
          {
            question: "Theme?",
            options: [{ label: "dark" }, { label: "light" }],
          },
        ],
      },
    });

    let msg = env.telegram
      .sentMessages()
      .find((m) => m.text?.includes("Question 1/2"));
    for (let i = 0; i < 40 && !msg; i++) {
      await settle(15);
      msg = env.telegram
        .sentMessages()
        .find((m) => m.text?.includes("Question 1/2"));
    }
    expect(msg).toBeDefined();
    expect(msg?.parseMode).toBe("HTML");

    const kb = msg!.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const persist = kb.inline_keyboard.flat().find((b) => b.text === "persist")!;
    await daemon.handleUpdate(
      callback(persist.callback_data, 2, msg!.message_id, session.messageThreadId),
    );
    await settle(30);

    // Second question via edit
    const edits = env.telegram.outbound.filter(
      (c) => c.method === "editMessageText",
    );
    const q2 = edits.find(
      (c) =>
        c.method === "editMessageText" &&
        c.params.text.includes("Question 2/2"),
    );
    expect(q2).toBeDefined();
    if (q2?.method !== "editMessageText") throw new Error("bad");
    const kb2 = q2.params.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const dark = kb2.inline_keyboard.flat().find((b) => b.text === "dark")!;
    await daemon.handleUpdate(
      callback(dark.callback_data, 3, msg!.message_id, session.messageThreadId),
    );

    const result = await promise;
    // Grok AskUserQuestionExtResponse::Accepted (internally tagged)
    expect(result).toEqual({
      outcome: "accepted",
      answers: {
        "What should we build?": "persist",
        "Theme?": "dark",
      },
      partial_answers: {},
    });
  });

  test("toAskUserQuestionExtResponse shapes accepted and skip", () => {
    expect(
      toAskUserQuestionExtResponse({
        answers: [
          {
            question: "What next?",
            header: "Next",
            selectedOptions: ["kanban", "persist"],
          },
        ],
      }),
    ).toEqual({
      outcome: "accepted",
      answers: { Next: "kanban, persist" },
      partial_answers: {},
    });
    expect(
      toAskUserQuestionExtResponse({ answers: [] }, { declined: true }),
    ).toEqual({ outcome: "skip_interview" });
  });
});
