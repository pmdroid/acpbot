import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { topicName } from "../src/core/status";
import { systemClock } from "../src/env/clock";
import { echoAgents } from "../src/env/echo-agents";
import { fakeTelegram } from "../src/env/fake-telegram";
import { memoryStore } from "../src/env/store";
import type { Environment, TelegramUpdate } from "../src/env/types";

/**
 * Working vertical surface using the SHIPPED echo agent backend (not the
 * scripted fake-agents test double). Proves create → topic prompt → reply.
 */

const OPERATOR = 7;
const CHAT = 9001;

function root(text: string, update_id: number): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id,
      date: 0,
      text,
      from: { id: OPERATOR, first_name: "op" },
      chat: { id: CHAT, type: "private" },
    },
  };
}

function topicMsg(
  threadId: number,
  text: string,
  update_id: number,
): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id,
      date: 0,
      text,
      from: { id: OPERATOR, first_name: "op" },
      chat: { id: CHAT, type: "private" },
      message_thread_id: threadId,
      is_topic_message: true,
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 15; i++) await Promise.resolve();
  await Bun.sleep(15);
}

describe("working surface with shipped echoAgents", () => {
  test("create session, prompt in topic, get echo reply with thread id", async () => {
    const telegram = fakeTelegram();
    const env: Environment = {
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
        defaultAgent: "echo",
      },
      telegram,
      agents: echoAgents({
        operatorUserId: OPERATOR,
        repos: { tacp: "/configured/repos/tacp" },
      }),
      clock: systemClock(),
      store: memoryStore(),
    };

    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new tacp demo", 1));

    const sessions = await daemon.listSessions();
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.sessionKey).toBe("tacp/demo");
    expect(session.messageThreadId).toBeGreaterThan(0);

    await daemon.handleUpdate(
      topicMsg(session.messageThreadId, "hello surface", 2),
    );
    await settle();

    const topicReplies = telegram
      .sentMessages()
      .filter((m) => m.messageThreadId === session.messageThreadId);
    expect(topicReplies.length).toBeGreaterThan(0);
    expect(
      topicReplies.some(
        (m) =>
          m.text?.includes("hello surface") && m.text?.includes("[echo/tacp]"),
      ),
    ).toBe(true);

    // Agent output must never appear without a thread id.
    for (const m of topicReplies) {
      expect(m.messageThreadId).toBe(session.messageThreadId);
    }

    const names = telegram.outbound
      .filter((c) => c.method === "editForumTopic")
      .map((c) => (c.method === "editForumTopic" ? c.params.name : ""));
    expect(names).toContain(topicName("tacp", "demo", "running"));
    expect(names).toContain(topicName("tacp", "demo", "done"));
  });

  test("non-operator gets silence on echo-backed core", async () => {
    const telegram = fakeTelegram();
    const env: Environment = {
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
      telegram,
      agents: echoAgents({
        operatorUserId: OPERATOR,
        repos: { tacp: "/configured/repos/tacp" },
      }),
      clock: systemClock(),
      store: memoryStore(),
    };
    const daemon = createDaemon(env);
    await daemon.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "/ping",
        from: { id: 99999, first_name: "stranger" },
        chat: { id: CHAT, type: "private" },
      },
    });
    expect(telegram.sentMessages()).toHaveLength(0);
  });
});
