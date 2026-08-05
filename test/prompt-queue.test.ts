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

    const queuedAck = env.telegram
      .sentMessages()
      .find((m) => /Queued/i.test(m.text ?? ""));
    expect(queuedAck).toBeDefined();

    // Finish first turn → second should start; queue ack deleted from chat
    releaseFirst();
    await settle(80);

    expect(env.agents.turns.length).toBeGreaterThanOrEqual(2);
    expect(env.agents.turns[1]!.input.text).toContain("hello two");

    const deletes = env.telegram.outbound.filter(
      (c) => c.method === "deleteMessage",
    );
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(
      deletes.some(
        (c) =>
          c.method === "deleteMessage" &&
          c.params.messageId === queuedAck!.message_id,
      ),
    ).toBe(true);

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

  test("/steer interrupts busy turn and runs immediately", async () => {
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
    env.agents.queueTurn("demo/s", {
      hold: firstHold,
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "first-should-cancel",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });
    env.agents.queueTurn("demo/s", {
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "steer-reply",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });
    env.agents.queueTurn("demo/s", {
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "queued-reply",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });

    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo s", 1));
    const tid = (await d.listSessions())[0]!.messageThreadId;
    env.telegram.clearOutbound();

    await d.handleUpdate(topic(tid, "long work", 2));
    await settle(20);
    await d.handleUpdate(topic(tid, "queued free text", 3));
    await settle(15);
    expect(env.agents.turns.length).toBe(1);

    await d.handleUpdate(topic(tid, "/steer go left instead", 4));
    await settle(80);

    // Steer ran as turn 2 without waiting for first hold release
    expect(env.agents.turns.length).toBeGreaterThanOrEqual(2);
    expect(env.agents.turns[1]!.input.text).toContain("go left instead");

    const texts = env.telegram.sentMessages().map((m) => m.text ?? "");
    expect(texts.some((t) => /Steering/i.test(t))).toBe(true);
    expect(texts.some((t) => /steer-reply/.test(t))).toBe(true);

    // Queued free-text still runs after steer completes
    await settle(80);
    expect(env.agents.turns.length).toBeGreaterThanOrEqual(3);
    const lastText =
      env.agents.turns[env.agents.turns.length - 1]!.input.text;
    expect(lastText).toContain("queued free text");
    expect(
      env.telegram.sentMessages().some((m) => /queued-reply/.test(m.text ?? "")),
    ).toBe(true);

    // Releasing the old hold should not start another turn
    releaseFirst();
    await settle(40);
  });

  test("/unqueue removes last queued item", async () => {
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
    env.agents.queueTurn("demo/u", {
      hold: firstHold,
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "first-done",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });
    env.agents.queueTurn("demo/u", {
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "keep-me-reply",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });

    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo u", 1));
    const tid = (await d.listSessions())[0]!.messageThreadId;
    env.telegram.clearOutbound();

    await d.handleUpdate(topic(tid, "running", 2));
    await settle(15);
    await d.handleUpdate(topic(tid, "keep-me", 3));
    await d.handleUpdate(topic(tid, "drop-me", 4));
    await settle(15);

    await d.handleUpdate(topic(tid, "/unqueue", 5));
    await settle(20);

    releaseFirst();
    await settle(80);

    // Only keep-me should have run after first
    const turnTexts = env.agents.turns.map((t) => t.input.text);
    expect(turnTexts.some((t) => t.includes("keep-me"))).toBe(true);
    expect(turnTexts.some((t) => t.includes("drop-me"))).toBe(false);
  });

  test("Remove button dequeues item via Q: callback", async () => {
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
    env.agents.queueTurn("demo/r", {
      hold: firstHold,
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "first-done",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });

    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo r", 1));
    const tid = (await d.listSessions())[0]!.messageThreadId;
    env.telegram.clearOutbound();

    await d.handleUpdate(topic(tid, "running", 2));
    await settle(15);
    await d.handleUpdate(topic(tid, "will-remove", 3));
    await settle(15);

    const withKb = env.telegram
      .sentMessages()
      .filter((m) => m.replyMarkup?.inline_keyboard?.length);
    const queued = withKb.find((m) => /Queued/i.test(m.text ?? ""));
    expect(queued).toBeDefined();
    const removeBtn = queued!.replyMarkup!.inline_keyboard
      .flat()
      .find((b) => /Remove/i.test(b.text));
    expect(removeBtn?.callback_data).toMatch(/^Q:/);

    await d.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "cq-rm",
        from: { id: OPERATOR, first_name: "op" },
        data: removeBtn!.callback_data,
        message: {
          message_id: queued!.message_id,
          date: 0,
          chat: { id: CHAT, type: "private" },
          message_thread_id: tid,
          text: queued!.text,
        },
      },
    });
    await settle(20);

    releaseFirst();
    await settle(60);

    // Removed item must not start a second turn
    expect(env.agents.turns.length).toBe(1);
    expect(env.agents.turns[0]!.input.text).toContain("running");
  });

  test("/steer when idle starts a normal turn", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/tmp/demo" },
      },
    });
    env.agents.queueTurn("demo/idle", {
      events: [
        { type: "turn_started" },
        {
          type: "agent_message_chunk",
          text: "idle-steer-ok",
        } as AcpTurnEvent,
        { type: "turn_ended", stopReason: "end_turn" },
      ],
      stopReason: "end_turn",
    });

    const d = createDaemon(env);
    await d.handleUpdate(root("/new demo idle", 1));
    const tid = (await d.listSessions())[0]!.messageThreadId;
    env.telegram.clearOutbound();

    await d.handleUpdate(topic(tid, "/steer just do this", 2));
    await settle(50);

    expect(env.agents.turns.length).toBe(1);
    expect(env.agents.turns[0]!.input.text).toContain("just do this");
    expect(
      env.telegram.sentMessages().some((m) => /idle-steer-ok/.test(m.text ?? "")),
    ).toBe(true);
  });
});
