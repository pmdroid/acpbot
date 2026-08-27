import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { AcpTurnEvent, TelegramUpdate } from "../src/env/types";

/**
 * Ticket 03: event queue must be drained without *awaiting* Telegram inside
 * the for-await consumer. Working-bubble paints are fire-and-forget (may race
 * Telegram after pulls start) but must not delay consuming every ACP event.
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

    const started = Date.now();
    await daemon.handleUpdate(topic(session.messageThreadId, "go", 2));

    // Wait until every event is pulled (must not wait on Telegram).
    for (let i = 0; i < 80 && pullCount < scripted.length; i++) {
      await Promise.resolve();
      await Bun.sleep(5);
    }
    const pullMs = Date.now() - started;

    expect(pullCount).toBe(scripted.length);
    expect(pullMs).toBeLessThan(80);

    for (let i = 0; i < 50; i++) await Promise.resolve();
    await Bun.sleep(200);

    const replies = env.telegram
      .sentMessages()
      .filter((m) => m.messageThreadId === session.messageThreadId);
    const joined = replies.map((m) => m.text ?? "").join("");
    expect(joined.includes("a") && joined.includes("b")).toBe(true);
    const agentReply = replies.find(
      (m) => (m.text ?? "").includes("a") && (m.text ?? "").includes("b"),
    );
    expect(agentReply?.disableNotification).toBeUndefined();
  });
});
