import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import {
  COMPUTER_CB,
  encodeComputerCallback,
  parseComputerCallback,
} from "../src/core/callbacks";
import {
  COMPUTER_GRANT_COPY,
  formatComputerStatusLine,
  formatSessionStatus,
} from "../src/acp/session-mode";
import { COMPUTER_GRANT_TTL_MS } from "../src/acp-host/protocol";
import type { HostsCatalog } from "../src/acp-host/hosts";
import { TelegramApiError, type TelegramUpdate } from "../src/env/types";
import { memoryStore } from "../src/env/store";

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
  messageId: number,
  threadId: number,
): TelegramUpdate {
  return {
    update_id: id,
    callback_query: {
      id: String(id),
      data,
      from: { id: OPERATOR, first_name: "op" },
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

async function openTopic() {
  const env = createFakeEnvironment({
    config: {
      operatorUserId: OPERATOR,
      operatorChatId: CHAT,
      repos: { demo: "/configured/repos/demo" },
    },
  });
  const daemon = createDaemon(env);
  await daemon.handleUpdate(root("/new demo box", 1));
  const session = (await daemon.listSessions())[0]!;
  return { env, daemon, session };
}

function topicTexts(
  env: ReturnType<typeof createFakeEnvironment>,
  threadId: number,
): string[] {
  return env.telegram
    .sentMessages()
    .filter((m) => m.messageThreadId === threadId)
    .map((m) => m.text ?? "");
}

describe("computer callback codec", () => {
  test("round-trip stays under 64 bytes", () => {
    const data = encodeComputerCallback("deadbeef", COMPUTER_CB.on);
    expect(data.startsWith("C:")).toBe(true);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(parseComputerCallback(data)).toEqual({
      token: "deadbeef",
      actionIndex: 0,
    });
    expect(parseComputerCallback(encodeComputerCallback("ab", COMPUTER_CB.off))).toEqual({
      token: "ab",
      actionIndex: 2,
    });
  });
});

describe("formatComputerStatusLine", () => {
  test("off when missing or expired", () => {
    expect(formatComputerStatusLine({ now: 1000 })).toMatch(/off/);
    expect(
      formatComputerStatusLine({
        now: 2000,
        grant: {
          enabled: true,
          watch: false,
          expiresAt: 1000,
          hostId: "local",
          grantedAt: 0,
        },
      }),
    ).toMatch(/off/);
  });

  test("granted line names host and watch", () => {
    const line = formatComputerStatusLine({
      now: 1000,
      grant: {
        enabled: true,
        watch: true,
        expiresAt: 1000 + 10 * 60_000,
        hostId: "studio",
        grantedAt: 1000,
      },
    });
    expect(line).toMatch(/granted/);
    expect(line).toContain("`studio`");
    expect(line).toMatch(/Watch on/);
    expect(line).not.toMatch(/disabled/i);
  });
});

describe("formatSessionStatus computerLine", () => {
  test("includes optional computer line", () => {
    const t = formatSessionStatus({
      sessionKey: "a/b",
      status: "idle",
      agent: "grok-build",
      cwd: "/tmp",
      threadId: 1,
      chatId: 2,
      computerLine: "🖥 Computer · off",
    });
    expect(t).toContain("🖥 Computer · off");
  });
});

describe("/computer commands", () => {
  test("/computer on persists grant and does not claim capture", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));

    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant?.enabled).toBe(true);
    expect(after.computerGrant?.watch).toBe(false);
    expect(after.computerGrant?.hostId).toBe("local");
    expect(after.computerGrant?.expiresAt).toBeGreaterThan(env.clock.now());
    expect(after.computerGrant?.expiresAt).toBeLessThanOrEqual(
      env.clock.now() + COMPUTER_GRANT_TTL_MS,
    );
    expect(env.agents.computerGrantCalls).toHaveLength(1);
    expect(env.agents.computerGrantCalls[0]?.grant.enabled).toBe(true);

    const texts = topicTexts(env, session.messageThreadId);
    expect(texts.some((t) => t.includes(COMPUTER_GRANT_COPY))).toBe(true);
    expect(texts.some((t) => /PR\s*\d/i.test(t))).toBe(false);
    expect(texts.some((t) => /disabled/i.test(t))).toBe(false);
  });

  test("/computer watch sets watch flag", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(
      topic(session.messageThreadId, "/computer watch", 2),
    );
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant?.watch).toBe(true);
    expect(after.computerGrant?.enabled).toBe(true);
  });

  test("/computer off revokes without cancelling a turn", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer off", 3));
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant).toBeUndefined();
    expect(env.agents.computerAbortCalls.length).toBeGreaterThan(0);
    expect(
      topicTexts(env, session.messageThreadId).some((t) =>
        /grant revoked/i.test(t),
      ),
    ).toBe(true);
  });

  test("ensure re-sends grant while persist is live", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));
    expect(env.agents.computerGrantCalls).toHaveLength(1);
    await daemon.handleUpdate(topic(session.messageThreadId, "/status", 3));
    expect(env.agents.computerGrantCalls.length).toBeGreaterThan(1);
    expect((await daemon.listSessions())[0]?.computerGrant?.enabled).toBe(
      true,
    );
  });

  test("/computer status and /status show computer line", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer", 2));
    expect(
      topicTexts(env, session.messageThreadId).some((t) =>
        /Computer · off/.test(t),
      ),
    ).toBe(true);

    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 3));
    await daemon.handleUpdate(topic(session.messageThreadId, "/status", 4));
    expect(
      topicTexts(env, session.messageThreadId).some((t) =>
        /Computer · granted/.test(t),
      ),
    ).toBe(true);
  });

  test("old host unknown type is host too old and does not persist", async () => {
    const { env, daemon, session } = await openTopic();
    env.agents.computerGrantError = "unknown type";
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant).toBeUndefined();
    expect(
      topicTexts(env, session.messageThreadId).some((t) =>
        /host too old/.test(t),
      ),
    ).toBe(true);
    expect(
      topicTexts(env, session.messageThreadId).some((t) => /disabled/i.test(t)),
    ).toBe(false);
  });

  test("/cancel revokes grant", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));
    await daemon.handleUpdate(topic(session.messageThreadId, "/cancel", 3));
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant).toBeUndefined();
    expect(env.agents.computerAbortCalls.length).toBeGreaterThan(0);
    expect(
      topicTexts(env, session.messageThreadId).some((t) =>
        /computer grant revoked/.test(t),
      ),
    ).toBe(true);
  });

  test("/fresh revokes grant", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));
    await daemon.handleUpdate(topic(session.messageThreadId, "/fresh", 3));
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant).toBeUndefined();
    expect(env.agents.computerAbortCalls.length).toBeGreaterThan(0);
  });

  test("/steer keeps grant", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));
    await daemon.handleUpdate(
      topic(session.messageThreadId, "/steer keep watching", 3),
    );
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant?.enabled).toBe(true);
    expect(env.agents.computerAbortCalls).toHaveLength(0);
  });

  test("grant persists across worker restart", async () => {
    const store = memoryStore();
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
      store,
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo persist", 1));
    const session = (await daemon.listSessions())[0]!;
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));

    const env2 = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
      store,
    });
    const daemon2 = createDaemon(env2);
    await daemon2.handleUpdate(root("/ping", 3));
    const loaded = (await daemon2.listSessions())[0]!;
    expect(loaded.computerGrant?.enabled).toBe(true);
    expect(loaded.computerGrant?.hostId).toBe("local");
    expect(env2.agents.computerGrantCalls).toHaveLength(1);
    expect(env2.agents.computerGrantCalls[0]?.sessionKey).toBe(
      session.sessionKey,
    );
  });

  test("restart rebind unknown type clears persist", async () => {
    const store = memoryStore();
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
      store,
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo stale", 1));
    const session = (await daemon.listSessions())[0]!;
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));

    const env2 = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
      store,
    });
    env2.agents.computerGrantError = "unknown type";
    const daemon2 = createDaemon(env2);
    await daemon2.handleUpdate(root("/ping", 3));
    const loaded = (await daemon2.listSessions())[0]!;
    expect(loaded.computerGrant).toBeUndefined();
    expect(
      topicTexts(env2, session.messageThreadId).some((t) =>
        /host too old/.test(t),
      ),
    ).toBe(true);
  });

  test("/status expires persist and aborts host", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));
    const live = (await daemon.listSessions())[0]!;
    expect(live.computerGrant).toBeDefined();
    live.computerGrant = {
      ...live.computerGrant!,
      expiresAt: env.clock.now() - 1,
    };
    await daemon.handleUpdate(topic(session.messageThreadId, "/status", 3));
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant).toBeUndefined();
    expect(env.agents.computerAbortCalls.length).toBeGreaterThan(0);
    expect(
      topicTexts(env, session.messageThreadId).some((t) =>
        /Computer · off/.test(t),
      ),
    ).toBe(true);
  });

  test("inline Enable button grants", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer", 2));
    const withKb = env.telegram.outbound.find(
      (c) =>
        c.method === "sendMessage" &&
        (c.params as { replyMarkup?: { inline_keyboard?: unknown } })
          .replyMarkup,
    );
    expect(withKb?.method).toBe("sendMessage");
    const kb =
      withKb?.method === "sendMessage"
        ? (withKb.params.replyMarkup as {
            inline_keyboard: Array<Array<{ callback_data: string }>>;
          })
        : undefined;
    const onData = kb?.inline_keyboard.flat().find((b) =>
      b.callback_data.endsWith(`:${COMPUTER_CB.on}`),
    )?.callback_data;
    expect(onData).toBeDefined();
    await daemon.handleUpdate(
      callback(onData!, 3, 99, session.messageThreadId),
    );
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant?.enabled).toBe(true);
  });

  test("resolveHostId change revokes previous host", async () => {
    const catalog: HostsCatalog = {
      hosts: {
        local: { id: "local", kind: "unix" },
        studio: {
          id: "studio",
          kind: "wss",
          url: "ws://studio.example",
          token: "t",
        },
      },
      repos: {
        demo: { path: "/configured/repos/demo", hostId: "local" },
      },
    };
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
        hostsCatalog: catalog,
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo hop", 1));
    const session = (await daemon.listSessions())[0]!;
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer on", 2));
    expect((await daemon.listSessions())[0]?.computerGrant?.hostId).toBe(
      "local",
    );

    catalog.repos.demo!.hostId = "studio";
    await daemon.handleUpdate(topic(session.messageThreadId, "/computer", 3));
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant).toBeUndefined();
    expect(
      env.agents.computerAbortCalls.some((c) => c.hostId === "local"),
    ).toBe(true);
  });

  test("incoming frame uses sendPhoto bytes and fire-and-forget ack", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(root("/ping", 2));
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    env.agents.raiseComputerFrame({
      sessionKey: session.sessionKey,
      jpegBase64: Buffer.from(jpeg).toString("base64"),
      caption: "🖥 screenshot · local",
      width: 10,
      height: 10,
      frameId: "f1",
      hostId: "local",
    });
    await Bun.sleep(20);
    const photo = env.telegram.outbound.find((c) => c.method === "sendPhoto");
    expect(photo?.method).toBe("sendPhoto");
    if (photo?.method === "sendPhoto") {
      expect(photo.params.data).toEqual(jpeg);
      expect(photo.params.caption).toMatch(/screenshot/);
    }
    expect(env.agents.computerFrameAckCalls).toEqual([
      { sessionKey: session.sessionKey, frameId: "f1" },
    ]);
  });

  test("sendPhoto 429 auto-pauses watch and surfaces a status line", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(
      topic(session.messageThreadId, "/computer watch", 2),
    );
    expect((await daemon.listSessions())[0]?.computerGrant?.watch).toBe(true);
    const grantsBefore = env.agents.computerGrantCalls.length;
    env.telegram.setSendPhotoError(
      new TelegramApiError(429, "Too Many Requests"),
    );
    env.agents.raiseComputerFrame({
      sessionKey: session.sessionKey,
      jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64"),
      caption: "🖥 watch · local",
      width: 10,
      height: 10,
      frameId: "w1",
      hostId: "local",
    });
    await Bun.sleep(30);
    const after = (await daemon.listSessions())[0]!;
    expect(after.computerGrant?.enabled).toBe(true);
    expect(after.computerGrant?.watch).toBe(false);
    expect(env.agents.computerFrameAckCalls).toHaveLength(0);
    expect(env.agents.computerGrantCalls.length).toBe(grantsBefore + 1);
    expect(env.agents.computerGrantCalls.at(-1)?.grant.watch).toBe(false);
    expect(
      topicTexts(env, session.messageThreadId).some((t) =>
        /Watch paused.*429/i.test(t),
      ),
    ).toBe(true);
  });

  test("host status watch=false persists off so /status does not rebind watch on", async () => {
    const { env, daemon, session } = await openTopic();
    await daemon.handleUpdate(
      topic(session.messageThreadId, "/computer watch", 2),
    );
    expect((await daemon.listSessions())[0]?.computerGrant?.watch).toBe(true);
    env.agents.raiseComputerStatus({
      sessionKey: session.sessionKey,
      text: "🖥 Watch paused — Telegram send failed (rate limit?). `/computer watch` to resume.",
      watch: false,
    });
    await Bun.sleep(20);
    expect((await daemon.listSessions())[0]?.computerGrant?.watch).toBe(false);
    const grantsBefore = env.agents.computerGrantCalls.length;
    await daemon.handleUpdate(
      topic(session.messageThreadId, "/computer", 3),
    );
    expect((await daemon.listSessions())[0]?.computerGrant?.watch).toBe(false);
    expect(env.agents.computerGrantCalls.length).toBeGreaterThan(grantsBefore);
    expect(env.agents.computerGrantCalls.at(-1)?.grant.watch).toBe(false);
    expect(
      topicTexts(env, session.messageThreadId).some((t) => /Watch off/.test(t)),
    ).toBe(true);
  });
});
