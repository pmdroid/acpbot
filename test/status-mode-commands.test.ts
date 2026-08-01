import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";
import { formatSessionStatus } from "../src/acp/session-mode";

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

describe("/status and /mode picker", () => {
  test("/status reports agent and mode", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        defaultAgent: "grok-build",
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo st", 1));
    const sessions = await d.listSessions();
    const tid = sessions[0]!.messageThreadId;

    await d.handleUpdate(topic(tid, "/status", 2));
    const texts = env.telegram.sentMessages().map((m) => m.text);
    const status = texts.find((t) => /Session/i.test(t) && /Agent/i.test(t));
    expect(status).toBeDefined();
    expect(status).toMatch(/grok-build/);
    expect(status).toMatch(/demo\/st/);
  });

  test("/status ensures (host may spawn) then reports model", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        defaultAgent: "grok-build",
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo st-ro", 1));
    const tid = (await d.listSessions())[0]!.messageThreadId;
    const before = env.agents.ensureCalls.length;

    await d.handleUpdate(topic(tid, "/status", 2));

    // Status must ensure so a cold host slot is launched/reattached.
    expect(env.agents.ensureCalls.length).toBeGreaterThan(before);
    const texts = env.telegram.sentMessages().map((m) => m.text);
    const status = texts.find((t) => /Session/i.test(t) && /Model:/i.test(t));
    expect(status).toBeDefined();
    expect(status).toMatch(/Model:/i);
  });

  test("/mode shows picker keyboard; callback sets mode", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo modes", 1));
    const sessions = await d.listSessions();
    const tid = sessions[0]!.messageThreadId;
    const key = sessions[0]!.sessionKey;

    await d.handleUpdate(topic(tid, "/mode", 2));
    const withKb = env.telegram
      .sentMessages()
      .filter((m) => m.replyMarkup?.inline_keyboard?.length);
    expect(withKb.length).toBeGreaterThan(0);
    const lastKb = withKb[withKb.length - 1]!;
    const flat = lastKb.replyMarkup!.inline_keyboard.flat();
    const planBtn = flat.find((b) => b.text.includes("plan"));
    expect(planBtn?.callback_data).toMatch(/^m:/);

    await d.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cq1",
        from: { id: OPERATOR, first_name: "op" },
        data: planBtn!.callback_data,
        message: {
          message_id: 99,
          date: 0,
          chat: { id: CHAT, type: "private" },
          message_thread_id: tid,
        },
      },
    });
    expect(env.agents.modes.get(key)).toBe("plan");
  });

  test("/mode toggle still toggles plan/build", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
      },
    });
    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo tog", 1));
    const sessions = await d.listSessions();
    const tid = sessions[0]!.messageThreadId;
    const key = sessions[0]!.sessionKey;

    // fake starts at read-only after ensure — set build first
    env.agents.modes.set(key, "build");
    await d.handleUpdate(topic(tid, "/mode toggle", 2));
    expect(env.agents.modes.get(key)).toBe("plan");
  });

  test("formatSessionStatus includes launch line", () => {
    const t = formatSessionStatus({
      sessionKey: "a/b",
      status: "idle",
      agent: "grok-build",
      launch: { command: "grok", args: ["agent", "stdio"] },
      mode: "build",
      availableModes: ["plan", "build"],
      cwd: "/tmp/x",
      threadId: 1,
      chatId: 2,
      mcpEnabled: true,
      mcpCount: 1,
      mcpNames: ["acpbot"],
      acpHost: true,
    });
    expect(t).toContain("grok agent stdio");
    expect(t).toContain("acpbot");
  });
});
