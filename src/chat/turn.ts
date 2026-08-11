/**
 * Shared turn client over a SessionHost (acp-host client or in-process).
 * No Telegram dependency — used by `acpbot chat` and later OpenAI gateway.
 */
import type {
  HostTurnEvent,
  SessionHost,
} from "../acp/session-host";

export type ChatTurnChunk =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | {
      type: "tool";
      toolCallId?: string;
      title?: string;
      status?: string;
      kind?: string;
    }
  | { type: "done"; status: string; stopReason?: string }
  | { type: "error"; message: string };

/** Minimal host surface required for turns (easy to fake in tests). */
export type ChatHost = Pick<
  SessionHost,
  "ensureSession" | "startTurn" | "cancel"
>;

export type StreamTurnInput = {
  sessionKey: string;
  agent: string;
  cwd: string;
  text: string;
  permissionMode?: "ask" | "bypass";
  forceNewSession?: boolean;
  forceRespawn?: boolean;
  signal?: AbortSignal;
};

/**
 * Ensure the slot, run one prompt turn, and yield simplified chunks.
 * Yields `done` when the turn finishes; yields `error` then `done` on failure.
 */
export async function* streamTurn(
  host: ChatHost,
  input: StreamTurnInput,
): AsyncGenerator<ChatTurnChunk> {
  const text = input.text.trim();
  if (!text) {
    yield { type: "error", message: "empty prompt" };
    yield { type: "done", status: "failed" };
    return;
  }

  await host.ensureSession({
    sessionKey: input.sessionKey,
    agent: input.agent,
    cwd: input.cwd,
    ...(input.permissionMode
      ? { permissionMode: input.permissionMode }
      : {}),
    ...(input.forceNewSession ? { forceNewSession: true } : {}),
    ...(input.forceRespawn ? { forceRespawn: true } : {}),
  });

  const turn = host.startTurn({
    sessionKey: input.sessionKey,
    text,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const onAbort = () => {
    void turn.cancel("signal aborted");
  };
  if (input.signal) {
    if (input.signal.aborted) {
      await turn.cancel("signal aborted");
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    for await (const ev of turn.events) {
      const chunk = mapEvent(ev);
      if (chunk) yield chunk;
    }
    const result = await turn.result;
    if (result.error?.message) {
      yield { type: "error", message: result.error.message };
    }
    yield {
      type: "done",
      status: result.status,
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message };
    yield { type: "done", status: "failed" };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Convenience: run a turn and collect assistant text only.
 */
export async function promptText(
  host: ChatHost,
  input: StreamTurnInput,
): Promise<{ text: string; status: string; stopReason?: string }> {
  let text = "";
  let status = "failed";
  let stopReason: string | undefined;
  for await (const chunk of streamTurn(host, input)) {
    if (chunk.type === "text") text += chunk.text;
    if (chunk.type === "done") {
      status = chunk.status;
      stopReason = chunk.stopReason;
    }
    if (chunk.type === "error" && !text) {
      // keep collecting; done follows
    }
  }
  return {
    text,
    status,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function mapEvent(ev: HostTurnEvent): ChatTurnChunk | null {
  switch (ev.type) {
    case "text_delta":
      if (!ev.text) return null;
      if (ev.stream === "thought") {
        return { type: "thought", text: ev.text };
      }
      return { type: "text", text: ev.text };
    case "tool_call":
      return {
        type: "tool",
        ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
        ...(ev.title ? { title: ev.title } : {}),
        ...(ev.status ? { status: ev.status } : {}),
        ...(ev.kind ? { kind: ev.kind } : {}),
      };
    case "error":
      return { type: "error", message: ev.message };
    case "done":
      // result promise is authoritative; skip intermediate done if any
      return null;
    default:
      return null;
  }
}
