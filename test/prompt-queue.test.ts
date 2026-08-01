/**
 * When a turn is in flight, further topic messages are queued and run FIFO.
 */
import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { AcpTurnEvent, TelegramUpdate } from "../src/env/types";

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

async function settle(ms = 30): Promise<void> {
  await Bun.sleep(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("prompt queue while turn busy", () => {
  test("second message is queued and runs after first turn ends", async () => {
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/tmp/demo" },
      },
    });

    // First turn blocks until we release; second is the default script.
    env.agents.queueTurn("demo/q", {
      hold: firstHold,
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "first-reply",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });
    env.agents.queueTurn("demo/q", {
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "second-reply",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });

    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo q", 1));
    const session = (await d.listSessions())[0]!;
    const tid = session.messageThreadId;

    env.telegram.clearOutbound();

    // Start first (held) turn
    await d.handleUpdate(topic(tid, "hello one", 2));
    await settle(20);

    // Second arrives while first is busy → queued
    await d.handleUpdate(topic(tid, "hello two", 3));
    await settle(20);

    const texts = env.telegram.sentMessages().map((m) => m.text ?? "");
    expect(texts.some((t) => /Queued/i.test(t))).toBe(true);

    // Only one turn started so far
    expect(env.agents.turns.length).toBe(1);
    expect(env.agents.turns[0]!.input.text).toContain("hello one");

    // Finish first turn → second should start
    releaseFirst();
    await settle(80);

    expect(env.agents.turns.length).toBeGreaterThanOrEqual(2);
    expect(env.agents.turns[1]!.input.text).toContain("hello two");

    const later = env.telegram.sentMessages().map((m) => m.text ?? "");
    expect(later.some((t) => /first-reply/.test(t))).toBe(true);
    expect(later.some((t) => /second-reply/.test(t))).toBe(true);
  });

  test("/cancel clears queued prompts", async () => {
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/tmp/demo" },
      },
    });
    env.agents.queueTurn("demo/c", {
      hold: firstHold,
      events: [
        { type: "turn_started" },
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });

    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo c", 1));
    const tid = (await d.listSessions())[0]!.messageThreadId;
    env.telegram.clearOutbound();

    await d.handleUpdate(topic(tid, "running", 2));
    await settle(15);
    await d.handleUpdate(topic(tid, "queued-a", 3));
    await d.handleUpdate(topic(tid, "queued-b", 4));
    await settle(15);

    await d.handleUpdate(topic(tid, "/cancel", 5));
    await settle(30);
    releaseFirst();
    await settle(40);

    const texts = env.telegram.sentMessages().map((m) => m.text ?? "");
    expect(texts.some((t) => /cancelled/i.test(t) && /queued/i.test(t))).toBe(
      true,
    );
    // No third turn for queued-a/b
    expect(env.agents.turns.length).toBe(1);
  });
});
