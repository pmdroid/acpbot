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

describe("topic mode slash commands", () => {
  test("/plan /build /mode drive setSessionMode", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo modesess", 1));
    const sessions = await d.listSessions();
    expect(sessions).toHaveLength(1);
    const tid = sessions[0]!.messageThreadId;
    const key = sessions[0]!.sessionKey;

    await d.handleUpdate(topic(tid, "/plan", 2));
    expect(env.agents.modes.get(key)).toBe("plan");

    await d.handleUpdate(topic(tid, "/build", 3));
    expect(env.agents.modes.get(key)).toBe("build");

    await d.handleUpdate(topic(tid, "/mode toggle", 4));
    expect(env.agents.modes.get(key)).toBe("plan");

    await d.handleUpdate(topic(tid, "/mode default", 5));
    expect(env.agents.modes.get(key)).toBe("default");

    const texts = env.telegram.sentMessages().map((m) => m.text);
    expect(texts.some((t) => /Mode|plan|build/i.test(t))).toBe(true);
  });
});
