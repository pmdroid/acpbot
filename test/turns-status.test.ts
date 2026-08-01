import { describe, expect, test } from "bun:test";
import { createDaemon } from "../src/core/daemon";
import { reduceStatus, topicName } from "../src/core/status";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { AcpTurnEvent, TelegramUpdate } from "../src/env/types";

const OPERATOR = 42;
const CHAT = 1000;

function root(text: string, update_id: number): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id,
      date: 0,
      text,
      from: { id: OPERATOR, first_name: "op" },
      chat: { id: CHAT, type: "private" },
    },
  };
}

function topicMsg(
  threadId: number,
  text: string,
  update_id: number,
): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id,
      date: 0,
      text,
      from: { id: OPERATOR, first_name: "op" },
      chat: { id: CHAT, type: "private" },
      message_thread_id: threadId,
      is_topic_message: true,
    },
  };
}

async function settle(): Promise<void> {
  // Allow long-lived drain tasks to process microtasks.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await Bun.sleep(10);
}

describe("status state machine", () => {
  test("scripted ACP sequences produce expected statuses", () => {
    const seq: AcpTurnEvent[] = [
      { type: "turn_started" },
      { type: "tool_call", toolCallId: "t1" },
      { type: "permission_raised", toolCallId: "t1" },
      { type: "permission_settled", toolCallId: "t1" },
      { type: "turn_ended", stopReason: "end_turn" },
    ];
    let s = reduceStatus("idle", seq[0]!);
    expect(s).toBe("running");
    s = reduceStatus(s, seq[1]!);
    expect(s).toBe("running");
    s = reduceStatus(s, seq[2]!);
    expect(s).toBe("waiting-on-you");
    s = reduceStatus(s, seq[3]!);
    expect(s).toBe("running");
    s = reduceStatus(s, seq[4]!);
    expect(s).toBe("done");

    expect(reduceStatus("running", { type: "process_died" })).toBe("failed");
  });
});

describe("03 — live turns with status projection", () => {
  test("prompt in a topic runs a turn with explicit cwd", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new acpbot work", 1));
    const session = (await daemon.listSessions())[0]!;

    env.agents.queueTurn("acpbot/work", {
      events: [
        { type: "turn_started" },
        { type: "turn_ended", stopReason: "end_turn" },
      ],
    });

    await daemon.handleUpdate(topicMsg(session.messageThreadId, "hello agent", 2));
    await settle();

    expect(env.agents.turns).toHaveLength(1);
    expect(env.agents.turns[0]?.handle.cwd).toBe("/configured/repos/tacp");
    expect(env.agents.turns[0]?.input.text).toBe("hello agent");
  });

  test("topic title never rewritten during a turn (status is the working bubble)", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new acpbot work", 1));
    const session = (await daemon.listSessions())[0]!;

    env.telegram.clearOutbound();
    env.agents.queueTurn("acpbot/work", {
      events: [
        { type: "turn_started" },
        { type: "turn_ended", stopReason: "end_turn" },
      ],
    });

    await daemon.handleUpdate(topicMsg(session.messageThreadId, "go", 2));
    await settle();

    const renames = env.telegram.outbound.filter(
      (c) => c.method === "editForumTopic",
    );
    expect(renames).toHaveLength(0);

    // Live working bubble still appears.
    const working = env.telegram
      .sentMessages()
      .filter((m) => m.text?.startsWith("⏳"));
    expect(working.length).toBeGreaterThan(0);
  });

  test("agent process dying does not rename topic to failed (bubble + message instead)", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new acpbot work", 1));
    const session = (await daemon.listSessions())[0]!;

    env.telegram.clearOutbound();
    env.agents.queueTurn("acpbot/work", {
      events: [{ type: "turn_started" }, { type: "process_died", error: "boom" }],
      die: "boom",
    });

    await daemon.handleUpdate(topicMsg(session.messageThreadId, "go", 2));
    await settle();

    const names = env.telegram.outbound
      .filter((c) => c.method === "editForumTopic")
      .map((c) => (c.method === "editForumTopic" ? c.params.name : undefined));
    expect(names).not.toContain(topicName("acpbot", "work"));
    // Status still tracked; failure is messaged in-topic.
    const after = (await daemon.listSessions()).find(
      (s) => s.sessionKey === "acpbot/work",
    );
    expect(after?.status).toBe("failed");
  });

  test("timeoutMs is never set on a turn", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new acpbot work", 1));
    const session = (await daemon.listSessions())[0]!;

    env.agents.queueTurn("acpbot/work", {
      events: [{ type: "turn_started" }, { type: "turn_ended" }],
    });
    await daemon.handleUpdate(topicMsg(session.messageThreadId, "go", 2));
    await settle();

    expect(env.agents.sawTimeoutMs).toBe(false);
    const input = env.agents.turns[0]?.input as Record<string, unknown>;
    expect("timeoutMs" in (input ?? {})).toBe(false);
  });

  test("final agent text is delivered in-topic; tool titles are not", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new acpbot work", 1));
    const session = (await daemon.listSessions())[0]!;

    env.agents.queueTurn("acpbot/work", {
      events: [
        { type: "turn_started" },
        { type: "agent_message_chunk", text: "AGENT REPLY HERE" },
        { type: "tool_call", toolCallId: "t1", title: "write file" },
        { type: "turn_ended" },
      ],
    });

    env.telegram.clearOutbound();
    await daemon.handleUpdate(topicMsg(session.messageThreadId, "go", 2));
    await settle();

    const topicSends = env.telegram
      .sentMessages()
      .filter((m) => m.messageThreadId === session.messageThreadId);
    expect(topicSends.some((m) => m.text?.includes("AGENT REPLY HERE"))).toBe(
      true,
    );
    const allText = topicSends.map((m) => m.text).join("\n");
    // Provisional volume policy: no tool-call titles / diffs in chat.
    expect(allText).not.toContain("write file");
  });

  test("end-to-end working loop: create session, prompt, get reply in topic", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);

    await daemon.handleUpdate(root("/new acpbot loop", 1));
    const session = (await daemon.listSessions())[0]!;
    expect(session.messageThreadId).toBeGreaterThan(0);

    env.agents.queueTurn("acpbot/loop", {
      events: [
        { type: "turn_started" },
        { type: "agent_message_chunk", text: "hello from the agent" },
        { type: "turn_ended", stopReason: "end_turn" },
      ],
    });

    await daemon.handleUpdate(
      topicMsg(session.messageThreadId, "say hello", 2),
    );
    await settle();

    const reply = env.telegram
      .sentMessages()
      .find(
        (m) =>
          m.messageThreadId === session.messageThreadId &&
          m.text?.includes("hello from the agent"),
      );
    expect(reply).toBeDefined();

    // Working bubble was used (and removed) rather than topic renames.
    expect(
      env.telegram.outbound.some((c) => c.method === "deleteMessage"),
    ).toBe(true);
  });

  test("session is placed in read-only mode before it can act", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { acpbot: "/configured/repos/tacp" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new acpbot work", 1));

    expect(env.agents.modes.get("acpbot/work")).toBe("read-only");
    // ensureSession ran before any turn
    expect(env.agents.ensureCalls).toHaveLength(1);
  });
});
