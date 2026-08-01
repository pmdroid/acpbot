import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDaemon } from "../src/core/daemon";
import { STORE_KEYS } from "../src/core/persistence";
import { echoAgents } from "../src/env/echo-agents";
import { systemClock } from "../src/env/clock";
import { fakeTelegram } from "../src/env/fake-telegram";
import { createJsonFileStore } from "../src/env/store";
import type { Environment, TelegramUpdate } from "../src/env/types";

const SCRATCH =
  "/var/folders/jg/xxmk6hrd4dbg0x2hl4mqv29m0000gn/T/grok-goal-644ece14a855/implementer";

function storePath(name: string): string {
  const dir = join(SCRATCH, "json-store-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

describe("createJsonFileStore (shipped production store)", () => {
  test("concurrent save of distinct keys retains all values", async () => {
    const path = storePath(`concurrent-${Date.now()}.json`);
    const store = await createJsonFileStore(path);

    const n = 20;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.save(`key-${i}`, { i, payload: `v${i}` }),
      ),
    );

    const keys = await store.listKeys();
    expect(keys.length).toBe(n);
    for (let i = 0; i < n; i++) {
      const v = await store.load<{ i: number; payload: string }>(`key-${i}`);
      expect(v).toEqual({ i, payload: `v${i}` });
    }
  });

  test("interleaved offset and sessions saves do not drop either key", async () => {
    const path = storePath(`race-offset-${Date.now()}.json`);
    const store = await createJsonFileStore(path);

    const sessions = {
      byKey: {
        "acpbot/a": {
          sessionKey: "acpbot/a",
          identity: { repo: "acpbot", name: "a" },
          messageThreadId: 10,
          chatId: 1,
          status: "idle",
          cwd: "/r",
          createdAt: 1,
          updatedAt: 1,
        },
      },
      byThread: { "10": "acpbot/a" },
    };

    await Promise.all([
      store.save(STORE_KEYS.updateOffset, 42),
      store.save(STORE_KEYS.sessions, sessions),
      store.save(STORE_KEYS.updateOffset, 43),
      store.save(STORE_KEYS.operatorChatId, 99),
    ]);

    const offset = await store.load<number>(STORE_KEYS.updateOffset);
    const idx = await store.load<typeof sessions>(STORE_KEYS.sessions);
    const chat = await store.load<number>(STORE_KEYS.operatorChatId);
    expect(offset).toBe(43);
    expect(idx?.byKey["acpbot/a"]?.sessionKey).toBe("acpbot/a");
    expect(chat).toBe(99);
  });
});

describe("daemon + createJsonFileStore durable path", () => {
  const OPERATOR = 11;
  const CHAT = 22;

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

  test("create + prompt + offset persist; restart recovers sessions:index", async () => {
    const path = storePath(`daemon-${Date.now()}.json`);
    const store = await createJsonFileStore(path);
    const telegram = fakeTelegram();

    const env: Environment = {
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
      telegram,
      agents: echoAgents({
        operatorUserId: OPERATOR,
        repos: { acpbot: "/configured/repos/tacp" },
      }),
      clock: systemClock(),
      store,
    };

    const d1 = createDaemon(env, { pollTimeoutSec: 0, conflictBackoffMs: 1 });
    await d1.handleUpdate(root("/new acpbot durable", 1));
    // Persist offset the way the poll loop does after each update.
    await store.save(STORE_KEYS.updateOffset, 2);

    const sessions1 = await d1.listSessions();
    expect(sessions1).toHaveLength(1);
    const threadId = sessions1[0]!.messageThreadId;

    await d1.handleUpdate(topic(threadId, "hello durable", 2));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await Bun.sleep(20);

    // Concurrent offset persist while drain may still be writing status.
    await Promise.all([
      store.save(STORE_KEYS.updateOffset, 3),
      store.save(STORE_KEYS.updateOffset, 4),
    ]);

    const onDiskSessions = await store.load<{
      byKey: Record<string, { sessionKey: string; messageThreadId: number }>;
    }>(STORE_KEYS.sessions);
    expect(onDiskSessions?.byKey["acpbot/durable"]).toBeDefined();
    expect(onDiskSessions?.byKey["acpbot/durable"]?.messageThreadId).toBe(
      threadId,
    );

    // New core over the same JSON file — real restart model for production store.
    const telegram2 = fakeTelegram();
    const store2 = await createJsonFileStore(path);
    const env2: Environment = {
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
      telegram: telegram2,
      agents: echoAgents({
        operatorUserId: OPERATOR,
        repos: { acpbot: "/configured/repos/tacp" },
      }),
      clock: systemClock(),
      store: store2,
    };
    const d2 = createDaemon(env2);
    const recovered = await d2.listSessions();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.sessionKey).toBe("acpbot/durable");
    expect(recovered[0]?.messageThreadId).toBe(threadId);

    const offset = await store2.load<number>(STORE_KEYS.updateOffset);
    expect(offset).toBe(4);

    // Routing still works after JSON restart.
    await d2.handleUpdate(topic(threadId, "still here", 5));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await Bun.sleep(20);
    const replies = telegram2
      .sentMessages()
      .filter((m) => m.messageThreadId === threadId);
    expect(replies.some((m) => m.text?.includes("still here"))).toBe(true);
  });
});
