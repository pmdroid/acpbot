import { describe, expect, test } from "bun:test";
import {
  encodeElicitationCallback,
  parseElicitationCallback,
} from "../src/core/callbacks";
import { createDaemon } from "../src/core/daemon";
import {
  buildElicitationUi,
  extractElicitationChoices,
} from "../src/core/elicitation";
import {
  formatForTelegram,
  markdownToTelegramHtml,
} from "../src/core/markdown";
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

async function settle(ms = 25): Promise<void> {
  for (let i = 0; i < 15; i++) await Promise.resolve();
  await Bun.sleep(ms);
}

describe("markdown → Telegram HTML", () => {
  test("bold italic code and links", () => {
    const html = markdownToTelegramHtml(
      "**bold** and *italic* and `code` and [x](https://x.ai)",
    );
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<i>italic</i>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://x.ai">x</a>');
  });

  test("formatForTelegram sets HTML mode", () => {
    const f = formatForTelegram("# Title\n\nHello **world**");
    expect(f.parseMode).toBe("HTML");
    expect(f.text).toContain("<b>Title</b>");
    expect(f.text).toContain("<b>world</b>");
  });
});

describe("elicitation multi-choice", () => {
  test("extracts enum options from form schema", () => {
    const { options, fieldName, message } = extractElicitationChoices({
      mode: "form",
      message: "Pick a **plan**",
      requestedSchema: {
        type: "object",
        properties: {
          approach: {
            type: "string",
            enum: ["fast", "careful", "skip"],
          },
        },
      },
    });
    expect(fieldName).toBe("approach");
    expect(message).toContain("plan");
    expect(options.map((o) => o.value)).toEqual(["fast", "careful", "skip"]);
  });

  test("buildElicitationUi produces buttons under 64 bytes", () => {
    const ui = buildElicitationUi({
      sessionId: "demo/q",
      raw: {
        message: "Which?",
        options: [
          { label: "Alpha", value: "a" },
          { label: "Beta", value: "b" },
        ],
      },
    });
    expect(ui.parseMode).toBe("HTML");
    const flat = ui.keyboard.inline_keyboard.flat();
    expect(flat.length).toBeGreaterThanOrEqual(3); // 2 + decline
    for (const b of flat) {
      expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(
        64,
      );
      expect(parseElicitationCallback(b.callback_data)).toBeDefined();
    }
  });

  test("daemon: elicitation keyboard round-trip settles accept", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo q", 1));
    env.telegram.clearOutbound();

    const promise = env.agents.raiseElicitation({
      sessionId: "demo/q",
      raw: {
        message: "Ship **now** or later?",
        requestedSchema: {
          properties: {
            when: { enum: ["now", "later"] },
          },
        },
      },
    });

    let prompt:
      | (ReturnType<typeof env.telegram.sentMessages>[number] & {
          message_id: number;
        })
      | undefined;
    for (let i = 0; i < 40 && !prompt; i++) {
      await settle(15);
      prompt = env.telegram
        .sentMessages()
        .find((m) => m.text?.includes("Agent question"));
    }
    expect(prompt).toBeDefined();
    expect(prompt?.parseMode).toBe("HTML");
    expect(prompt?.text).toContain("<b>");

    const kb = prompt?.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const nowBtn = kb.inline_keyboard.flat().find((b) => b.text === "now")!;
    expect(nowBtn).toBeDefined();

    const session = (await daemon.listSessions())[0]!;
    await daemon.handleUpdate(
      callback(
        nowBtn.callback_data,
        2,
        prompt!.message_id,
        session.messageThreadId,
      ),
    );

    const decision = await promise;
    expect(decision).toEqual({
      action: "accept",
      content: { when: "now" },
    });
  });

  test("encode/parse elicitation decline index", () => {
    const d = encodeElicitationCallback("aabbcc", -1);
    expect(parseElicitationCallback(d)).toEqual({
      token: "aabbcc",
      optionIndex: -1,
    });
  });
});

describe("agent final text uses HTML parse mode", () => {
  test("echo reply is sent with parseMode HTML", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    // Use scripted fake agent with markdown
    const { createDaemon: cd } = await import("../src/core/daemon");
    const daemon = cd(env);
    await daemon.handleUpdate(root("/new demo md", 1));
    const session = (await daemon.listSessions())[0]!;
    env.agents.queueTurn("demo/md", {
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "## Result\n\nUse **bold** and `code`.",
        },
        { type: "turn_ended", stopReason: "end_turn" },
      ],
    });
    env.telegram.clearOutbound();
    await daemon.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        text: "go",
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
        message_thread_id: session.messageThreadId,
        is_topic_message: true,
      },
    });
    await settle(40);
    const reply = env.telegram
      .sentMessages()
      .find((m) => m.messageThreadId === session.messageThreadId);
    expect(reply?.parseMode).toBe("HTML");
    expect(reply?.text).toContain("<b>");
  });
});
