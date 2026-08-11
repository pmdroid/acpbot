import { describe, expect, test } from "bun:test";
import type { HostTurn, HostTurnEvent, SessionHost } from "../src/acp/session-host";
import { promptText, streamTurn, type ChatHost } from "../src/chat/turn";

function fakeHost(script: HostTurnEvent[]): ChatHost {
  let cancelled = false;
  return {
    async ensureSession(input) {
      return {
        sessionKey: input.sessionKey,
        agentSessionId: "fake-sid",
        cwd: input.cwd,
        agent: input.agent,
        currentModeId: "default",
        availableModeIds: ["default", "plan"],
        configOptions: [],
      };
    },
    startTurn(_input) {
      const events = (async function* (): AsyncGenerator<HostTurnEvent> {
        for (const ev of script) {
          if (cancelled) {
            yield { type: "done", stopReason: "cancelled" };
            return;
          }
          yield ev;
        }
      })();
      const result = Promise.resolve({
        status: cancelled ? "cancelled" : "completed",
        stopReason: cancelled ? "cancelled" : "end_turn",
      });
      return {
        events,
        result,
        cancel: async () => {
          cancelled = true;
        },
      } satisfies HostTurn;
    },
    async cancel() {
      cancelled = true;
    },
  };
}

describe("streamTurn", () => {
  test("streams text deltas and done", async () => {
    const host = fakeHost([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "done", stopReason: "end_turn" },
    ]);
    const chunks = [];
    for await (const c of streamTurn(host, {
      sessionKey: "demo/main",
      agent: "echo",
      cwd: "/tmp",
      text: "hi",
    })) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.type === "text")).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ]);
    const done = chunks.find((c) => c.type === "done");
    expect(done).toMatchObject({ type: "done", status: "completed" });
  });

  test("maps thought stream separately", async () => {
    const host = fakeHost([
      { type: "text_delta", text: "think", stream: "thought" },
      { type: "text_delta", text: "say" },
    ]);
    const chunks = [];
    for await (const c of streamTurn(host, {
      sessionKey: "demo/main",
      agent: "echo",
      cwd: "/tmp",
      text: "x",
    })) {
      chunks.push(c);
    }
    expect(chunks.some((c) => c.type === "thought" && c.text === "think")).toBe(
      true,
    );
    expect(chunks.some((c) => c.type === "text" && c.text === "say")).toBe(true);
  });

  test("empty prompt fails without ensure", async () => {
    let ensured = false;
    const host: ChatHost = {
      async ensureSession() {
        ensured = true;
        throw new Error("should not ensure");
      },
      startTurn() {
        throw new Error("should not start");
      },
      async cancel() {},
    };
    const chunks = [];
    for await (const c of streamTurn(host, {
      sessionKey: "demo/main",
      agent: "echo",
      cwd: "/tmp",
      text: "   ",
    })) {
      chunks.push(c);
    }
    expect(ensured).toBe(false);
    expect(chunks[0]).toMatchObject({ type: "error" });
    expect(chunks[1]).toMatchObject({ type: "done", status: "failed" });
  });

  test("cancel via AbortSignal", async () => {
    const host = fakeHost([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
    ]);
    const ac = new AbortController();
    // abort immediately after start
    queueMicrotask(() => ac.abort());
    const chunks = [];
    for await (const c of streamTurn(host, {
      sessionKey: "demo/main",
      agent: "echo",
      cwd: "/tmp",
      text: "hi",
      signal: ac.signal,
    })) {
      chunks.push(c);
    }
    expect(chunks.some((c) => c.type === "done")).toBe(true);
  });

  test("promptText collects assistant text", async () => {
    const host = fakeHost([
      { type: "text_delta", text: "one " },
      { type: "tool_call", title: "grep" },
      { type: "text_delta", text: "two" },
    ]);
    const r = await promptText(host, {
      sessionKey: "demo/main",
      agent: "echo",
      cwd: "/tmp",
      text: "hi",
    });
    expect(r.text).toBe("one two");
    expect(r.status).toBe("completed");
  });
});

// type-only sanity: ChatHost is assignable from partial SessionHost
test("ChatHost is a SessionHost pick", () => {
  const _h: ChatHost = null as unknown as SessionHost;
  expect(_h).toBeNull();
});
