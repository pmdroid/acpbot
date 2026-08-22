import { describe, expect, test } from "bun:test";
import {
  createPromptTurnQueue,
  isCurrentPromptStop,
  pumpPromptTurn,
  takeQueueMessage,
  type AcpQueueMessage,
  type PromptTurnPumpEvent,
} from "../src/acp/prompt-turn";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeQueue() {
  const buf: AcpQueueMessage[] = [];
  let wait: ((m: AcpQueueMessage) => void) | undefined;
  const queue = createPromptTurnQueue(
    () =>
      new Promise<AcpQueueMessage>((res) => {
        if (buf.length > 0) res(buf.shift()!);
        else wait = res;
      }),
  );
  return {
    queue,
    push(m: AcpQueueMessage) {
      if (wait) {
        const w = wait;
        wait = undefined;
        w(m);
      } else buf.push(m);
    },
  };
}

async function collect(
  gen: AsyncGenerator<PromptTurnPumpEvent>,
): Promise<PromptTurnPumpEvent[]> {
  const out: PromptTurnPumpEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("prompt-turn leftover stop", () => {
  test("isCurrentPromptStop uses object identity", () => {
    const a = { stopReason: "end_turn" };
    const b = { stopReason: "end_turn" };
    expect(
      isCurrentPromptStop(
        { kind: "stop", response: a, stopReason: "end_turn" },
        a,
      ),
    ).toBe(true);
    expect(
      isCurrentPromptStop(
        { kind: "stop", response: b, stopReason: "end_turn" },
        a,
      ),
    ).toBe(false);
    expect(
      isCurrentPromptStop(
        { kind: "stop", response: a, stopReason: "end_turn" },
        undefined,
      ),
    ).toBe(false);
  });

  test("takeQueueMessage parks the in-flight read on timeout", async () => {
    const { queue, push } = makeQueue();
    const first = takeQueueMessage(queue, 20);
    expect(await first).toBe("timeout");
    expect(queue.pending).toBeDefined();
    const later = { kind: "stop" as const, response: { n: 1 }, stopReason: "end_turn" };
    push(later);
    expect(await takeQueueMessage(queue)).toEqual(later);
  });

  test("happy path yields updates then this prompt's stop", async () => {
    const { queue, push } = makeQueue();
    const ac = new AbortController();
    const response = { stopReason: "end_turn" };
    const prompt = deferred<{ stopReason?: string }>();

    const gen = pumpPromptTurn({
      prompt: () => prompt.promise,
      queue,
      signal: ac.signal,
      cancelAgent: async () => {},
    });

    const collected = collect(gen);
    push({
      kind: "session_update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    });
    await Bun.sleep(5);
    prompt.resolve(response);
    push({ kind: "stop", response, stopReason: "end_turn" });
    const evs = await collected;
    expect(evs).toEqual([
      {
        type: "update",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  test("leftover stop does not complete the next turn", async () => {
    const { queue, push } = makeQueue();
    queue.abandonedPrompts = 1;
    const leftover = { stopReason: "cancelled" };
    const ours = { stopReason: "end_turn" };
    const prompt = deferred<{ stopReason?: string }>();
    const ac = new AbortController();

    const gen = pumpPromptTurn({
      prompt: () => prompt.promise,
      queue,
      signal: ac.signal,
      cancelAgent: async () => {},
    });
    const collected = collect(gen);

    push({
      kind: "session_update",
      update: { sessionUpdate: "tool_call", title: "old" },
    });
    push({ kind: "stop", response: leftover, stopReason: "cancelled" });
    await Bun.sleep(10);
    expect(queue.abandonedPrompts).toBe(0);

    push({
      kind: "session_update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "status" } },
    });
    prompt.resolve(ours);
    push({ kind: "stop", response: ours, stopReason: "end_turn" });
    const evs = await collected;
    expect(evs.filter((e) => e.type === "update")).toEqual([
      {
        type: "update",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "status" } },
      },
    ]);
    expect(evs.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  test("cancel drain consumes matching stop without orphaning", async () => {
    const { queue, push } = makeQueue();
    const ac = new AbortController();
    const response = { stopReason: "cancelled" };
    const prompt = deferred<{ stopReason?: string }>();
    let cancelled = 0;

    const gen = pumpPromptTurn({
      prompt: () => prompt.promise,
      queue,
      signal: ac.signal,
      cancelAgent: async () => {
        cancelled += 1;
      },
      cancelDrainMs: 200,
    });
    ac.abort();
    const collected = collect(gen);
    prompt.resolve(response);
    push({ kind: "stop", response, stopReason: "cancelled" });
    const evs = await collected;
    expect(cancelled).toBe(1);
    expect(queue.abandonedPrompts).toBe(0);
    expect(evs).toEqual([{ type: "cancelled", stopReason: "cancelled" }]);
  });

  test("cancel timeout marks abandonedPrompts for the next turn", async () => {
    const { queue } = makeQueue();
    const ac = new AbortController();
    const prompt = deferred<{ stopReason?: string }>();

    const gen = pumpPromptTurn({
      prompt: () => prompt.promise,
      queue,
      signal: ac.signal,
      cancelAgent: async () => {},
      cancelDrainMs: 25,
    });
    ac.abort();
    const evs = await collect(gen);
    expect(evs).toEqual([{ type: "cancelled", stopReason: "cancelled" }]);
    expect(queue.abandonedPrompts).toBe(1);
    expect(queue.pending).toBeDefined();
  });
});
