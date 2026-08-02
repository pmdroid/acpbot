import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { AcpTurnEvent, TelegramUpdate } from "../src/env/types";

/**
 * Ticket 03: event queue must be drained without awaiting Telegram inside
 * the for-await consumer. Working bubble may post before the stream; once
 * pulls start, no Telegram I/O may interleave until the stream is exhausted.
 */

const OPERATOR = 3;
const CHAT = 4;

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

describe("drainTurn does not gate the event queue on Telegram", () => {
  test("all events are consumed before drain-side Telegram I/O", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/acpbot" },
      },
    });

    const seq: string[] = [];
    const originalSend = env.telegram.sendMessage.bind(env.telegram);
    const originalDelete = env.telegram.deleteMessage.bind(env.telegram);

    env.telegram.sendMessage = async (params) => {
      seq.push(`telegram:sendMessage`);
      await Bun.sleep(10);
      return originalSend(params);
    };
    env.telegram.deleteMessage = async (params) => {
      seq.push(`telegram:deleteMessage`);
      await Bun.sleep(10);
      return originalDelete(params);
    };

    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new acpbot drain", 1));
    const session = (await daemon.listSessions())[0]!;

    // Clear create-session outbound noise.
    seq.length = 0;
    env.telegram.clearOutbound();

    const scripted: AcpTurnEvent[] = [
      { type: "turn_started" },
      { type: "agent_message_chunk", text: "a" },
      { type: "agent_message_chunk", text: "b" },
      { type: "tool_call", toolCallId: "t1" },
      { type: "turn_ended", stopReason: "end_turn" },
    ];

    let pullCount = 0;
    env.agents.queueTurn("acpbot/drain", {
      events: [], // replaced by custom iterator below via monkey patch
    });

    // Replace runPromptTurn to yield a tracked async iterator.
    const realRun = env.agents.runPromptTurn.bind(env.agents);
    env.agents.runPromptTurn = async (handle, input) => {
      const base = await realRun(handle, input);
      const tracked = (async function* () {
        for (const ev of scripted) {
          pullCount += 1;
          seq.push(`pull:${pullCount}:${ev.type}`);
          yield ev;
        }
      })();
      return {
        events: tracked,
        done: base.done,
      };
    };

    await daemon.handleUpdate(topic(session.messageThreadId, "go", 2));

    // Wait for drain + side effects.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await Bun.sleep(200);

    expect(pullCount).toBe(scripted.length);

    const firstPull = seq.findIndex((s) => s.startsWith("pull:"));
    const lastPull = (() => {
      let idx = -1;
      for (let i = 0; i < seq.length; i++) {
        if (seq[i]!.startsWith("pull:")) idx = i;
      }
      return idx;
    })();

    expect(firstPull).toBeGreaterThan(-1);
    expect(lastPull).toBeGreaterThan(-1);

    // Working bubble may post before pulls; once streaming starts, no Telegram
    // side-effects may interleave until every event has been pulled.
    for (let i = firstPull; i <= lastPull; i++) {
      expect(seq[i]!.startsWith("pull:")).toBe(true);
    }

    // Reply still delivered after drain.
    const replies = env.telegram
      .sentMessages()
      .filter((m) => m.messageThreadId === session.messageThreadId);
    expect(replies.some((m) => m.text?.includes("ab"))).toBe(true);
  });
});
