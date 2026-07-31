import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
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

function topic(threadId: number, text: string, id: number): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      text,
      from: { id: OPERATOR, first_name: "op" },
      chat: { id: CHAT, type: "private" },
      message_thread_id: threadId,
      is_topic_message: true,
    },
  };
}

describe("/model and /agent", () => {
  test("/model picker sets model", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo m1", 1));
    const sessions = await d.listSessions();
    const tid = sessions[0]!.messageThreadId;
    const key = sessions[0]!.sessionKey;

    await d.handleUpdate(topic(tid, "/model", 2));
    const withKb = env.telegram
      .sentMessages()
      .filter((m) => m.replyMarkup?.inline_keyboard?.length);
    const last = withKb[withKb.length - 1]!;
    const smart = last.replyMarkup!.inline_keyboard
      .flat()
      .find((b) => /smart/i.test(b.text));
    expect(smart?.callback_data).toMatch(/^M:/);

    await d.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "c1",
        from: { id: OPERATOR, first_name: "op" },
        data: smart!.callback_data,
        message: {
          message_id: 50,
          date: 0,
          chat: { id: CHAT, type: "private" },
          message_thread_id: tid,
        },
      },
    });
    expect(env.agents.models.get(key)).toBe("smart");
  });

  test("/model smart by name", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo m2", 1));
    const sessions = await d.listSessions();
    const tid = sessions[0]!.messageThreadId;
    const key = sessions[0]!.sessionKey;
    await d.handleUpdate(topic(tid, "/model smart", 2));
    expect(env.agents.models.get(key)).toBe("smart");
  });

  test("/agent claude switches identity", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        defaultAgent: "grok-build",
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo a1", 1));
    const sessions = await d.listSessions();
    const tid = sessions[0]!.messageThreadId;
    await d.handleUpdate(topic(tid, "/agent claude", 2));
    const after = await d.listSessions();
    expect(after[0]!.identity.agent).toBe("claude");
    expect(
      env.agents.ensureCalls.some((c) => c.agent === "claude"),
    ).toBe(true);
  });

  test("/status includes Model line", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo s1", 1));
    const tid = (await d.listSessions())[0]!.messageThreadId;
    await d.handleUpdate(topic(tid, "/status", 2));
    const texts = env.telegram.sentMessages().map((m) => m.text);
    expect(texts.some((t) => /Model:/i.test(t))).toBe(true);
  });
});
