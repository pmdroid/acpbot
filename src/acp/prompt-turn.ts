/**
 * ACP session/prompt + nextUpdate pump.
 *
 * @agentclientprotocol/sdk queues the PromptResponse as a `stop` on the same
 * FIFO as session/update notifications. If a turn returns on abort without
 * consuming that stop, the next startTurn treats it as *this* prompt finishing
 * (often in a few ms, with leftover tool/text events). /steer hits this.
 *
 * This pump binds each turn to its own prompt() result object and discards
 * unmatched stops. Abandoned turns increment `abandonedPrompts` so leftover
 * session/update noise is dropped until those stops drain.
 */
import type { LogMeta } from "../env/logger";

export const CANCEL_DRAIN_MS = 1500;

export type AcpStopMessage = {
  kind: "stop";
  response: unknown;
  stopReason?: string;
};

export type AcpUpdateMessage = {
  kind: "session_update";
  update: unknown;
};

export type AcpQueueMessage = AcpStopMessage | AcpUpdateMessage;

export type PromptTurnQueue = {
  nextUpdate: () => Promise<AcpQueueMessage>;
  /** In-flight nextUpdate() parked across a timed-out cancel drain. */
  pending?: Promise<AcpQueueMessage>;
  /** prompt() RPCs whose stop has not been consumed. */
  abandonedPrompts: number;
};

export type PromptTurnPumpEvent =
  | { type: "update"; update: unknown }
  | { type: "done"; stopReason: string }
  | { type: "cancelled"; stopReason: string }
  | { type: "error"; message: string };

export type PromptTurnPumpLog = {
  warn(msg: string, meta?: LogMeta): void;
};

export function createPromptTurnQueue(
  nextUpdate: () => Promise<AcpQueueMessage>,
): PromptTurnQueue {
  return { nextUpdate, abandonedPrompts: 0 };
}

/**
 * Read the next queued ACP message. On timeout, park the in-flight read on
 * `queue.pending` so the next call still receives it (no stolen nextUpdate).
 */
export async function takeQueueMessage(
  queue: PromptTurnQueue,
  timeoutMs?: number,
): Promise<AcpQueueMessage | "timeout"> {
  const pending = queue.pending ?? queue.nextUpdate();
  delete queue.pending;
  if (timeoutMs === undefined) {
    return await pending;
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      pending.then((m) => ({ tag: "msg" as const, m })),
      new Promise<{ tag: "timeout" }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ tag: "timeout" }), timeoutMs);
      }),
    ]);
    if (raced.tag === "timeout") {
      queue.pending = pending;
      return "timeout";
    }
    return raced.m;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function isCurrentPromptStop(
  message: AcpQueueMessage,
  currentResponse: unknown | undefined,
): boolean {
  return (
    message.kind === "stop" &&
    currentResponse !== undefined &&
    message.response === currentResponse
  );
}

export async function* pumpPromptTurn(input: {
  prompt: () => Promise<{ stopReason?: string }>;
  queue: PromptTurnQueue;
  signal: AbortSignal;
  cancelAgent: () => Promise<void>;
  log?: PromptTurnPumpLog;
  cancelDrainMs?: number;
}): AsyncGenerator<PromptTurnPumpEvent> {
  const drainMs = input.cancelDrainMs ?? CANCEL_DRAIN_MS;
  let mineRes: { stopReason?: string } | undefined;
  const mine = input.prompt();
  void mine.then(
    (v) => {
      mineRes = v;
    },
    () => {
      /* nextUpdate rejects; pump catch handles it */
    },
  );

  let cancelSent = false;
  const sendCancel = async () => {
    if (cancelSent) return;
    cancelSent = true;
    try {
      await input.cancelAgent();
    } catch {
      /* best effort */
    }
  };

  try {
    for (;;) {
      const aborted = input.signal.aborted;
      if (aborted) await sendCancel();

      const msg = await takeQueueMessage(
        input.queue,
        aborted ? drainMs : undefined,
      );
      if (msg === "timeout") {
        input.queue.abandonedPrompts += 1;
        input.log?.warn("prompt cancel timed out waiting for stop", {
          abandonedPrompts: input.queue.abandonedPrompts,
        });
        yield { type: "cancelled", stopReason: "cancelled" };
        return;
      }

      // Let prompt().then assign mineRes before identity check (same tick as SDK enqueue).
      await Promise.resolve();

      if (msg.kind === "stop") {
        if (!isCurrentPromptStop(msg, mineRes)) {
          if (input.queue.abandonedPrompts > 0) {
            input.queue.abandonedPrompts -= 1;
          }
          input.log?.warn("discarded leftover prompt stop", {
            stopReason: msg.stopReason ?? null,
            abandonedPrompts: input.queue.abandonedPrompts,
            oursSettled: mineRes !== undefined,
          });
          continue;
        }
        const stopReason = String(
          (msg as AcpStopMessage).stopReason ?? "end_turn",
        );
        if (aborted || stopReason === "cancelled") {
          yield { type: "cancelled", stopReason: "cancelled" };
          return;
        }
        yield { type: "done", stopReason };
        return;
      }

      if (aborted) continue;
      if (input.queue.abandonedPrompts > 0) continue;
      yield { type: "update", update: msg.update };
    }
  } catch (err) {
    yield {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
