import { describe, expect, test } from "bun:test";
import { createTurnRunner } from "../src/core/turn-runner";
import {
  capReply,
  DEFAULT_MAX_REPLY_CHARS,
  DEFAULT_REPLY_GUIDANCE,
} from "../src/core/telegram-reply";
import type { AcpTurnEvent, Environment } from "../src/env/types";
import type { PersistedSession } from "../src/core/persistence";
import { createLogger } from "../src/env/logger";

describe("capReply", () => {
  test("passthrough under limit", () => {
    const r = capReply("short", DEFAULT_MAX_REPLY_CHARS);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("short");
    expect(r.full).toBe("short");
  });

  test("truncates at line boundary and keeps full text", () => {
    const line = "x".repeat(50) + "\n";
    const text = line.repeat(100);
    const r = capReply(text, 120);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(122);
    expect(r.text.endsWith("…")).toBe(true);
    expect(r.full).toBe(text);
  });

  test("0 disables the cap", () => {
    const r = capReply("y".repeat(9000), 0);
    expect(r.truncated).toBe(false);
  });
});

function makeSession(): PersistedSession {
  return {
    sessionKey: "demo/s",
    identity: { repo: "demo", name: "s", agent: "echo" },
    messageThreadId: 1,
    chatId: 1,
    status: "running",
    cwd: "/tmp",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("turn runner enforces max reply chars", () => {
  test("long final reply is truncated and full text sent as document", async () => {
    const sent: Array<{ text: string; notify?: boolean }> = [];
    const docs: Array<{
      filename: string;
      data: Uint8Array;
      caption: string | undefined;
    }> = [];
    const session = makeSession();
    const long = Array.from(
      { length: 60 },
      (_, i) => `line ${i}: ${" detail".repeat(20)}`,
    ).join("\n");

    const events: AcpTurnEvent[] = [
      { type: "turn_started" },
      { type: "agent_message_chunk", text: long },
      { type: "turn_ended", stopReason: "end_turn" },
    ];

    const runner = createTurnRunner({
      env: {
        config: { operatorUserId: 1, telegram: { maxReplyChars: 2000 } },
        telegram: {
          sendDocument: async (p: {
            filename: string;
            data: Uint8Array;
            caption: string | undefined;
          }) => {
            docs.push(p);
            return { message_id: 99 };
          },
        } as unknown as Environment["telegram"],
        agents: {} as Environment["agents"],
        clock: { now: () => 0, sleep: async () => {} },
        store: {} as Environment["store"],
      },
      working: {
        ensure: async () => {},
        set: async () => {},
        clear: async () => {},
        bump: async () => {},
        messageId: () => undefined,
      },
      sendInTopic: async (_s, text, _m, opts) => {
        sent.push(
          opts?.notify === true ? { text, notify: true } : { text },
        );
        return { message_id: sent.length };
      },
      setSessionStatus: async () => {},
      log: createLogger({ level: "silent", name: "test" }),
    });

    await runner.drainTurn(session, (async function* () {
      for (const e of events) yield e;
    })());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text.length).toBeLessThanOrEqual(2002);
    expect(sent[0]!.text.endsWith("…")).toBe(true);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toMatch(/^reply-.*\.md$/);
    expect(new TextDecoder().decode(docs[0]!.data)).toBe(long);
    expect(docs[0]!.caption).toContain(String(long.length));
  });

  test("short reply sends no document", async () => {
    const sent: Array<{ text: string }> = [];
    let docs = 0;
    const session = makeSession();

    const runner = createTurnRunner({
      env: {
        config: { operatorUserId: 1, telegram: { maxReplyChars: 2000 } },
        telegram: {
          sendDocument: async () => {
            docs++;
            return { message_id: 1 };
          },
        } as unknown as Environment["telegram"],
        agents: {} as Environment["agents"],
        clock: { now: () => 0, sleep: async () => {} },
        store: {} as Environment["store"],
      },
      working: {
        ensure: async () => {},
        set: async () => {},
        clear: async () => {},
        bump: async () => {},
        messageId: () => undefined,
      },
      sendInTopic: async (_s, text) => {
        sent.push({ text });
        return { message_id: 1 };
      },
      setSessionStatus: async () => {},
      log: createLogger({ level: "silent", name: "test" }),
    });

    await runner.drainTurn(session, (async function* () {
      yield { type: "turn_started" };
      yield { type: "agent_message_chunk", text: "all done" };
      yield { type: "turn_ended", stopReason: "end_turn" };
    })());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("all done");
    expect(docs).toBe(0);
  });
});

describe("reply guidance default", () => {
  test("mentions Telegram and brevity", () => {
    expect(DEFAULT_REPLY_GUIDANCE).toContain("Telegram");
    expect(DEFAULT_REPLY_GUIDANCE.length).toBeLessThan(500);
  });
});
