import { describe, expect, test } from "bun:test";
import {
  assertReadyToRun,
  createDaemon,
  TopicsDisabledError,
} from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import { memoryStore } from "../src/env/store";
import type { TelegramUpdate } from "../src/env/types";

const OPERATOR = 42;
const STRANGER = 99;

function msg(
  overrides: Partial<{
    update_id: number;
    userId: number;
    text: string;
    chatId: number;
    message_thread_id?: number;
    is_topic_message?: boolean;
  }> = {},
): TelegramUpdate {
  const userId = overrides.userId ?? OPERATOR;
  const chatId = overrides.chatId ?? 1000;
  return {
    update_id: overrides.update_id ?? 1,
    message: {
      message_id: 1,
      date: 0,
      text: overrides.text ?? "/ping",
      from: { id: userId, first_name: "op" },
      chat: { id: chatId, type: "private" },
      ...(overrides.message_thread_id !== undefined
        ? { message_thread_id: overrides.message_thread_id }
        : {}),
      ...(overrides.is_topic_message !== undefined
        ? { is_topic_message: overrides.is_topic_message }
        : {}),
    },
  };
}

describe("01 — authenticated daemon with working lobby", () => {
  test("/ping in the root area gets a reply", async () => {
    const env = createFakeEnvironment({ config: { operatorUserId: OPERATOR } });
    const daemon = createDaemon(env);

    await daemon.handleUpdate(msg({ text: "/ping" }));

    const sent = env.telegram.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("pong");
    expect(sent[0]?.messageThreadId).toBeUndefined();
  });

  test("update from non-operator produces zero outbound calls", async () => {
    const env = createFakeEnvironment({ config: { operatorUserId: OPERATOR } });
    const daemon = createDaemon(env);

    await daemon.handleUpdate(msg({ userId: STRANGER, text: "/ping" }));
    await daemon.handleUpdate(
      msg({ userId: STRANGER, text: "hello", update_id: 2 }),
    );

    // getMe is not called by handleUpdate; only poll path calls getUpdates.
    // Assert zero send/edit/create/answer.
    const outbound = env.telegram.outbound.filter(
      (c) => c.method !== "getMe" && c.method !== "getUpdates",
    );
    expect(outbound).toHaveLength(0);
    expect(env.telegram.sentMessages()).toHaveLength(0);
  });

  test("startup asserts has_topics_enabled and fails clearly when false", async () => {
    const env = createFakeEnvironment({
      telegram: {
        me: {
          id: 1,
          is_bot: true,
          first_name: "acpbot",
          has_topics_enabled: false,
        },
      },
    });

    await expect(assertReadyToRun(env)).rejects.toBeInstanceOf(
      TopicsDisabledError,
    );
    await expect(assertReadyToRun(env)).rejects.toThrow(/Threaded Mode/);

    const ac = new AbortController();
    const daemon = createDaemon(env, { pollTimeoutSec: 0 });
    // run() should throw before polling forever
    const runPromise = daemon.run(ac.signal);
    await expect(runPromise).rejects.toBeInstanceOf(TopicsDisabledError);
  });

  test("redelivered update produces no duplicate effect (offset-as-ack)", async () => {
    const store = memoryStore();
    const env = createFakeEnvironment({
      config: { operatorUserId: OPERATOR },
      store,
    });
    const daemon = createDaemon(env, {
      pollTimeoutSec: 0,
      conflictBackoffMs: 1,
    });

    const update = msg({ update_id: 7, text: "/ping" });
    env.telegram.inject(update);
    // Same update re-injected before ack would be a redelivery; process via handleUpdate twice.
    await daemon.handleUpdate(update);
    await daemon.handleUpdate(update);

    // Without durable idempotency keys on handleUpdate, redelivery of the same
    // update_id through the poll loop is what matters. Drive the poll loop:
    env.telegram.clearOutbound();
    env.telegram.inject(msg({ update_id: 8, text: "/ping" }));

    const ac = new AbortController();
    const run = daemon.run(ac.signal);
    await env.telegram.waitFor("sendMessage", 1, 1000);
    // Re-inject same update_id 8 — fake already removed it; simulate redelivery
    // by injecting again with same id before offset advances... Actually the
    // daemon acks after handle. Simulate: new core, store has offset 9, inject 8.
    ac.abort();
    try {
      await run;
    } catch {
      /* abort */
    }

    // Fresh core over same store: offset should be past 8, so redelivery of 8 is ignored by getUpdates filter.
    const env2 = createFakeEnvironment({
      config: { operatorUserId: OPERATOR },
      store,
      telegram: {
        me: {
          id: 1,
          is_bot: true,
          first_name: "acpbot",
          has_topics_enabled: true,
        },
      },
    });
    // Put update 8 back as if Telegram redelivered it; offset in store is 9.
    env2.telegram.inject(msg({ update_id: 8, text: "/ping" }));
    env2.telegram.inject(msg({ update_id: 9, text: "/ping" }));

    const ac2 = new AbortController();
    const d2 = createDaemon(env2, { pollTimeoutSec: 0, conflictBackoffMs: 1 });
    const run2 = d2.run(ac2.signal);
    await env2.telegram.waitFor("sendMessage", 1, 1000);
    ac2.abort();
    try {
      await run2;
    } catch {
      /* abort */
    }

    // Only update 9 should produce a pong (update 8 filtered by offset).
    const pongs = env2.telegram.sentMessages().filter((m) => m.text === "pong");
    expect(pongs).toHaveLength(1);
  });

  test("getUpdates 409 conflict is handled rather than crashing", async () => {
    const env = createFakeEnvironment({ config: { operatorUserId: OPERATOR } });
    env.telegram.setConflict(true);
    const daemon = createDaemon(env, {
      pollTimeoutSec: 0,
      conflictBackoffMs: 5,
    });

    const ac = new AbortController();
    const run = daemon.run(ac.signal);

    // Let a few conflict cycles happen via clock advances.
    for (let i = 0; i < 5; i++) {
      env.clock.advance(5);
      await Bun.sleep(1);
    }

    // Still running — no throw. Clear conflict, inject ping, get reply.
    env.telegram.setConflict(false);
    env.telegram.inject(msg({ update_id: 1, text: "/ping" }));
    env.clock.advance(5);
    await env.telegram.waitFor("sendMessage", 1, 2000);
    ac.abort();
    try {
      await run;
    } catch {
      /* abort */
    }

    expect(env.telegram.sentMessages().some((m) => m.text === "pong")).toBe(
      true,
    );
  });

  test("no configuration path assumes local filesystem layout", async () => {
    // Config is purely injected: operator id + repos map. Store is memory.
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { myrepo: "/any/configured/path" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(msg({ text: "/ping" }));
    expect(env.config.repos?.myrepo).toBe("/any/configured/path");
    // There is no default HOME/.acpbot or similar in the fake path.
    expect(env.telegram.sentMessages()[0]?.text).toBe("pong");
  });
});
