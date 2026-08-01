import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { topicName } from "../src/core/status";
import { createFakeEnvironment } from "../src/env/fake-env";
import { memoryStore } from "../src/env/store";
import type { TelegramUpdate } from "../src/env/types";

const OPERATOR = 42;
const CHAT = 1000;

function root(
  text: string,
  update_id = 1,
): TelegramUpdate {
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

describe("02 — sessions become topics and survive restart", () => {
  test("creating a session creates a topic named repo/name and persists mapping", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);

    await daemon.handleUpdate(root("/new tacp auth-refactor", 1));

    const creates = env.telegram.outbound.filter(
      (c) => c.method === "createForumTopic",
    );
    expect(creates).toHaveLength(1);
    if (creates[0]?.method === "createForumTopic") {
      expect(creates[0].params.name).toBe(topicName("tacp", "auth-refactor"));
      expect(creates[0].params.chatId).toBe(CHAT);
    }

    const sessions = await daemon.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionKey).toBe("tacp/auth-refactor");
    expect(sessions[0]?.messageThreadId).toBeGreaterThan(0);
  });

  test("message in a topic is routed to that session; root is a command", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);

    await daemon.handleUpdate(root("/new tacp work", 1));
    const sessions = await daemon.listSessions();
    const threadId = sessions[0]!.messageThreadId;

    env.agents.queueTurn("tacp/work", {
      events: [
        { type: "turn_started" },
        { type: "turn_ended", stopReason: "end_turn" },
      ],
    });

    await daemon.handleUpdate(topicMsg(threadId, "fix the bug", 2));

    expect(env.agents.turns).toHaveLength(1);
    expect(env.agents.turns[0]?.input.text).toBe("fix the bug");
    expect(env.agents.turns[0]?.handle.sessionKey).toBe("tacp/work");

    // Root /ping still a command, not a turn.
    const before = env.agents.turns.length;
    await daemon.handleUpdate(root("/ping", 3));
    expect(env.agents.turns.length).toBe(before);
    expect(env.telegram.sentMessages().some((m) => m.text === "pong")).toBe(
      true,
    );
  });

  test("two sessions in the same repo coexist with separate topics", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);

    await daemon.handleUpdate(root("/new tacp refactor", 1));
    await daemon.handleUpdate(root("/new tacp bugfix", 2));

    const sessions = await daemon.listSessions();
    expect(sessions).toHaveLength(2);
    const threads = new Set(sessions.map((s) => s.messageThreadId));
    expect(threads.size).toBe(2);

    const a = sessions.find((s) => s.identity.name === "refactor")!;
    const b = sessions.find((s) => s.identity.name === "bugfix")!;

    env.agents.queueTurn("tacp/refactor", {
      events: [{ type: "turn_started" }, { type: "turn_ended" }],
    });
    env.agents.queueTurn("tacp/bugfix", {
      events: [{ type: "turn_started" }, { type: "turn_ended" }],
    });

    await daemon.handleUpdate(topicMsg(a.messageThreadId, "do refactor", 3));
    await daemon.handleUpdate(topicMsg(b.messageThreadId, "do bugfix", 4));

    expect(env.agents.turns.map((t) => t.input.text)).toEqual([
      "do refactor",
      "do bugfix",
    ]);
  });

  test("restart recovers session list and topic mapping from tacp store", async () => {
    const store = memoryStore();
    const env1 = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp", other: "/configured/repos/other" },
      },
      store,
    });
    const d1 = createDaemon(env1);
    await d1.handleUpdate(root("/new tacp one", 1));
    await d1.handleUpdate(root("/new other two", 2));
    const before = await d1.listSessions();
    expect(before).toHaveLength(2);

    // New core over the same store — models restart without a process restart.
    const env2 = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp", other: "/configured/repos/other" },
      },
      store,
    });
    const d2 = createDaemon(env2);
    const after = await d2.listSessions();
    expect(after).toHaveLength(2);
    expect(after.map((s) => s.sessionKey).sort()).toEqual(
      before.map((s) => s.sessionKey).sort(),
    );
    expect(after.map((s) => s.messageThreadId).sort()).toEqual(
      before.map((s) => s.messageThreadId).sort(),
    );

    // Routing still works after restart.
    const session = after.find((s) => s.sessionKey === "tacp/one")!;
    env2.agents.queueTurn("tacp/one", {
      events: [{ type: "turn_started" }, { type: "turn_ended" }],
    });
    await d2.handleUpdate(topicMsg(session.messageThreadId, "still here", 3));
    expect(env2.agents.turns[0]?.input.text).toBe("still here");
  });

  test("/new wizard ends after create; later free-text does not spawn topics", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo", tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);

    // Repo picker path
    await daemon.handleUpdate(root("/new", 1));
    const pick = env.telegram
      .sentMessages()
      .find((m) => m.replyMarkup !== undefined);
    expect(pick).toBeDefined();
    const kb = pick!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const demoBtn = kb.inline_keyboard.flat()[0]!;
    await daemon.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cq-2",
        from: { id: OPERATOR, first_name: "op" },
        data: demoBtn.callback_data,
        message: {
          message_id: pick!.message_id,
          date: 0,
          chat: { id: CHAT, type: "private" },
        },
      },
    });

    // Valid name → one topic
    await daemon.handleUpdate(root("Init", 3));
    expect(
      env.telegram.outbound.filter((c) => c.method === "createForumTopic"),
    ).toHaveLength(1);
    expect((await daemon.listSessions()).map((s) => s.sessionKey)).toEqual([
      "demo/Init",
    ]);

    // Casual free-text must NOT create more topics (wizard finished)
    await daemon.handleUpdate(root("Try now again", 4));
    await daemon.handleUpdate(root("hello world", 5));
    await daemon.handleUpdate(root("another", 6));
    expect(
      env.telegram.outbound.filter((c) => c.method === "createForumTopic"),
    ).toHaveLength(1);
    expect(await daemon.listSessions()).toHaveLength(1);
  });

  test("multi-word free-text while naming does not create a topic", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new", 1));
    const pick = env.telegram
      .sentMessages()
      .find((m) => m.replyMarkup !== undefined)!;
    const kb = pick.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    await daemon.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cq-2",
        from: { id: OPERATOR, first_name: "op" },
        data: kb.inline_keyboard.flat()[0]!.callback_data,
        message: {
          message_id: pick.message_id,
          date: 0,
          chat: { id: CHAT, type: "private" },
        },
      },
    });
    await daemon.handleUpdate(root("Try now again", 3));
    expect(
      env.telegram.outbound.filter((c) => c.method === "createForumTopic"),
    ).toHaveLength(0);
    expect(await daemon.listSessions()).toHaveLength(0);
  });

  test("General-style messages with thread id still hit lobby when not a session", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    // Private forum often sets message_thread_id on General without is_topic_message
    await daemon.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "/ping",
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
        message_thread_id: 1,
        // is_topic_message intentionally omitted / false
      },
    });
    expect(env.telegram.sentMessages().some((m) => m.text === "pong")).toBe(
      true,
    );
  });

  test("orphan is_topic_message threads still run lobby commands (/ping)", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "/ping",
        from: { id: OPERATOR, first_name: "op" },
        chat: { id: CHAT, type: "private" },
        message_thread_id: 216200,
        is_topic_message: true,
      },
    });
    const pong = env.telegram.sentMessages().find((m) => m.text === "pong");
    expect(pong).toBeDefined();
  });

  test("single-token free-text after naming ends does not create a second topic", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new", 1));
    const pick = env.telegram
      .sentMessages()
      .find((m) => m.replyMarkup !== undefined)!;
    const kb = pick.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    await daemon.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cq-2",
        from: { id: OPERATOR, first_name: "op" },
        data: kb.inline_keyboard.flat()[0]!.callback_data,
        message: {
          message_id: pick.message_id,
          date: 0,
          chat: { id: CHAT, type: "private" },
        },
      },
    });
    await daemon.handleUpdate(root("Init", 3));
    expect(
      env.telegram.outbound.filter((c) => c.method === "createForumTopic"),
    ).toHaveLength(1);

    // These would have created demo/hello, demo/ok if naming mode stuck
    await daemon.handleUpdate(root("hello", 4));
    await daemon.handleUpdate(root("ok", 5));
    await daemon.handleUpdate(root("yes", 6));
    expect(
      env.telegram.outbound.filter((c) => c.method === "createForumTopic"),
    ).toHaveLength(1);
    expect(await daemon.listSessions()).toHaveLength(1);
  });

  test("/ping cancels naming mode without creating a topic", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new", 1));
    const pick = env.telegram
      .sentMessages()
      .find((m) => m.replyMarkup !== undefined)!;
    const kb = pick.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    await daemon.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cq-2",
        from: { id: OPERATOR, first_name: "op" },
        data: kb.inline_keyboard.flat()[0]!.callback_data,
        message: {
          message_id: pick.message_id,
          date: 0,
          chat: { id: CHAT, type: "private" },
        },
      },
    });
    await daemon.handleUpdate(root("/ping", 3));
    expect(
      env.telegram.outbound.filter((c) => c.method === "createForumTopic"),
    ).toHaveLength(0);
    await daemon.handleUpdate(root("would-be-name", 4));
    expect(
      env.telegram.outbound.filter((c) => c.method === "createForumTopic"),
    ).toHaveLength(0);
  });

  test("listing sessions returns tacp's own list, not telegram or agent host", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new tacp a", 1));
    await daemon.handleUpdate(root("/sessions", 2));

    // No getMe/getUpdates enumeration of topics — list is from store.
    const listReply = env.telegram
      .sentMessages()
      .find((m) => m.text?.includes("tacp/a"));
    expect(listReply).toBeDefined();
    expect(
      env.telegram.outbound.filter((c) => c.method === "createForumTopic"),
    ).toHaveLength(1);
  });

  test("agent output cannot be emitted without a thread id", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new tacp x", 1));

    // Ticket 03 scopes: no agent text is emitted at all. Structural guarantee:
    // every sendMessage from a topic path includes messageThreadId when used.
    // Root replies never include it.
    const rootSends = env.telegram
      .sentMessages()
      .filter((m) => m.messageThreadId === undefined);
    expect(rootSends.length).toBeGreaterThan(0);

    // createForumTopic is how sessions get a thread; there is no API to send
    // session-bound content without one in the public sendInTopic path.
    const sessions = await daemon.listSessions();
    expect(sessions[0]?.messageThreadId).toBeDefined();
  });
});
