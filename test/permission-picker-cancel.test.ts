import { describe, expect, test } from "bun:test";
import {
  encodeNewRepoCallback,
  encodePermissionCallback,
  parseNewRepoCallback,
  parsePermissionCallback,
} from "../src/core/callbacks";
import { createDaemon } from "../src/core/daemon";
import {
  buildPermissionUi,
  decisionFromOption,
  extractPermissionOptions,
} from "../src/core/permissions";
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

function topic(
  threadId: number,
  text: string,
  id: number,
): TelegramUpdate {
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

function callback(
  data: string,
  id: number,
  messageId = 50,
  threadId?: number,
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
        ...(threadId !== undefined
          ? { message_thread_id: threadId, is_topic_message: true }
          : {}),
      },
    },
  };
}

async function settle(ms = 30): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await Bun.sleep(ms);
}

describe("callback_data encoding (64-byte safe)", () => {
  test("permission and repo callbacks round-trip under 64 bytes", () => {
    const p = encodePermissionCallback("aabbccdd1122", 3);
    expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(64);
    expect(parsePermissionCallback(p)).toEqual({
      token: "aabbccdd1122",
      optionIndex: 3,
    });
    const n = encodeNewRepoCallback(2);
    expect(parseNewRepoCallback(n)).toBe(2);
  });

  test("extract options never hardcodes only allow/deny names", () => {
    const opts = extractPermissionOptions({
      options: [
        { optionId: "a1", name: "Proceed once", kind: "allow_once" },
        { optionId: "r1", name: "No", kind: "reject_once" },
      ],
    });
    expect(opts).toHaveLength(2);
    expect(decisionFromOption(opts[0]!)).toEqual({ outcome: "allow_once" });
    expect(decisionFromOption(opts[1]!)).toEqual({ outcome: "reject_once" });
  });
});

describe("minimal repo picker", () => {
  test("/new without args offers repo keyboard from config", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: {
          tacp: "/configured/repos/tacp",
          other: "/configured/repos/other",
        },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new", 1));

    const sent = env.telegram.sentMessages();
    const pick = sent.find((m) => m.text?.includes("Which repo"));
    expect(pick).toBeDefined();
    const markup = pick?.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const labels = markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain("tacp");
    expect(labels).toContain("other");
  });

  test("repo callback then name creates session topic", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: {
          tacp: "/configured/repos/tacp",
          other: "/configured/repos/other",
        },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new", 1));
    const pick = env.telegram.sentMessages().find((m) =>
      m.text?.includes("Which repo"),
    );
    const markup = pick?.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const tacpBtn = markup.inline_keyboard
      .flat()
      .find((_, i) => Object.keys(env.config.repos!)[i] === "tacp")
      ?? markup.inline_keyboard.flat()[0]!;

    await daemon.handleUpdate(
      callback(tacpBtn.callback_data, 2, pick?.message_id ?? 1),
    );
    await daemon.handleUpdate(root("auth-refactor", 3));

    const sessions = await daemon.listSessions();
    expect(sessions.some((s) => s.sessionKey === "tacp/auth-refactor")).toBe(
      true,
    );
  });
});

describe("permission inline keyboard round-trip", () => {
  test("raises keyboard, marks waiting in bubble, settles via callback + edit", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    // Prime hydrate + permission wire without starting a held turn.
    await daemon.handleUpdate(root("/new tacp perm", 1));
    const session = (await daemon.listSessions())[0]!;
    env.telegram.clearOutbound();

    // Raise permission through the agents port (simulates ACP host hook).
    // No concurrent turn required for the UI round-trip itself.
    const permPromise = env.agents.raisePermission({
      sessionId: "tacp/perm",
      toolCallId: "tc1",
      raw: {
        options: [
          { optionId: "yes", name: "Allow once", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
        toolCall: { title: "Write file", toolCallId: "tc1" },
      },
    });

    // Wait until the permission prompt lands in the topic.
    let permMsg:
      | (ReturnType<typeof env.telegram.sentMessages>[number] & {
          message_id: number;
        })
      | undefined;
    for (let i = 0; i < 50 && !permMsg; i++) {
      await settle(20);
      permMsg = env.telegram
        .sentMessages()
        .find((m) => m.text?.includes("Agent needs permission"));
    }
    expect(permMsg).toBeDefined();

    // Status is in the working bubble, not via topic renames.
    const waitingBubble = env.telegram
      .sentMessages()
      .find(
        (m) =>
          m.messageThreadId === session.messageThreadId &&
          m.text?.startsWith("❓"),
      );
    expect(waitingBubble?.text).toMatch(/Waiting/i);
    expect(
      env.telegram.outbound.filter((c) => c.method === "editForumTopic"),
    ).toHaveLength(0);

    expect(permMsg?.messageThreadId).toBe(session.messageThreadId);
    const kb = permMsg?.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string; text: string }>>;
    };
    expect(kb.inline_keyboard.flat().length).toBe(2);
    const allow = kb.inline_keyboard.flat().find((b) =>
      b.text.includes("Allow"),
    )!;
    expect(new TextEncoder().encode(allow.callback_data).length).toBeLessThanOrEqual(
      64,
    );
    expect(parsePermissionCallback(allow.callback_data)).toBeDefined();

    // Operator taps Allow.
    await daemon.handleUpdate(
      callback(
        allow.callback_data,
        3,
        permMsg!.message_id,
        session.messageThreadId,
      ),
    );

    const decision = await permPromise;
    expect(decision).toEqual({ outcome: "allow_once" });

    // Confirmation via editMessageText (keyboard cleared).
    const edits = env.telegram.outbound.filter(
      (c) => c.method === "editMessageText",
    );
    expect(edits.length).toBeGreaterThan(0);
    expect(
      edits.some(
        (c) =>
          c.method === "editMessageText" &&
          c.params.text.includes("allow_once") &&
          c.params.text.includes("answered"),
      ),
    ).toBe(true);
  });

  test("buildPermissionUi keeps callback_data within 64 bytes", () => {
    const ui = buildPermissionUi({
      sessionId: "s",
      toolCallId: "t",
      raw: {
        options: [
          {
            optionId: "x",
            name: "A very long option name that should be truncated in the button",
            kind: "allow_once",
          },
        ],
      },
    });
    for (const row of ui.keyboard.inline_keyboard) {
      for (const btn of row) {
        expect(new TextEncoder().encode(btn.callback_data).length).toBeLessThanOrEqual(
          64,
        );
      }
    }
  });
});

describe("/cancel stops turn and keeps session", () => {
  test("cancel aborts hold, keeps session, clears working bubble", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { tacp: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new tacp cxl", 1));
    const session = (await daemon.listSessions())[0]!;

    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    env.agents.queueTurn("tacp/cxl", {
      events: [{ type: "turn_started" }],
      hold,
    });

    await daemon.handleUpdate(topic(session.messageThreadId, "long work", 2));
    await settle(20);

    await daemon.handleUpdate(topic(session.messageThreadId, "/cancel", 3));
    await settle(40);
    release();
    await settle(40);

    const sessions = await daemon.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionKey).toBe("tacp/cxl");

    const cancelMsg = env.telegram
      .sentMessages()
      .find((m) => m.text?.includes("cancelled") && m.text?.includes("kept"));
    expect(cancelMsg?.messageThreadId).toBe(session.messageThreadId);

    // Topic title is never rewritten for status.
    expect(
      env.telegram.outbound.filter((c) => c.method === "editForumTopic"),
    ).toHaveLength(0);
    expect(sessions[0]?.status).toBe("idle");
  });
});
