import { describe, expect, test } from "bun:test";
import {
  formatElapsedWorking,
  formatToolWorkingLabel,
  formatWorkingStatus,
} from "../src/core/working-status";
import { createTurnRunner } from "../src/core/turn-runner";
import type { AcpTurnEvent, Environment } from "../src/env/types";
import type { PersistedSession } from "../src/core/persistence";
import { createLogger } from "../src/env/logger";

describe("formatToolWorkingLabel", () => {
  test("subagent / research", () => {
    expect(
      formatToolWorkingLabel("spawn_subagent", {
        description: "Research Spotify Web API v1",
      }),
    ).toContain("subagent");
    expect(
      formatToolWorkingLabel("Research OpenTUI Bun MVP", {}),
    ).toMatch(/subagent|Research/i);
  });

  test("wait on tasks", () => {
    expect(
      formatToolWorkingLabel("Get task output: 2 tasks", {
        timeout_ms: 300000,
      }),
    ).toContain("background tasks");
    expect(
      formatToolWorkingLabel("get_command_or_subagent_output"),
    ).toContain("background tasks");
  });

  test("web search and fetch", () => {
    expect(formatToolWorkingLabel("Web search:")).toContain("Searching");
    expect(
      formatToolWorkingLabel("Fetch: https://example.com/docs", {
        url: "https://example.com/docs",
      }),
    ).toContain("Fetching");
  });

  test("write / todo / ask", () => {
    expect(
      formatToolWorkingLabel("Write `/tmp/x.md`", {
        file_path: "/tmp/x.md",
      }),
    ).toContain("Writing");
    expect(formatToolWorkingLabel("todo_write")).toContain("plan");
    expect(formatToolWorkingLabel("ask_user_question")).toContain("question");
  });
});

describe("formatElapsedWorking", () => {
  test("no clock under 12s", () => {
    expect(formatElapsedWorking("Waiting on background tasks…", 5000)).toBe(
      "Waiting on background tasks…",
    );
  });

  test("appends clock", () => {
    expect(formatElapsedWorking("Waiting on background tasks…", 90_000)).toBe(
      "Waiting on background tasks… (1m 30s)",
    );
    expect(formatElapsedWorking("Working…", 20_000)).toBe("Working… (20s)");
  });

  test("formatWorkingStatus prefixes hourglass", () => {
    expect(formatWorkingStatus("Running a command…")).toBe(
      "⏳ Running a command…",
    );
  });
});

describe("turn runner holds agent text until turn end", () => {
  test("one notified send after tools, no mid-turn posts", async () => {
    const paints: string[] = [];
    const sent: Array<{ text: string; notify?: boolean }> = [];
    const session: PersistedSession = {
      sessionKey: "demo/s",
      identity: { repo: "demo", name: "s", agent: "echo" },
      messageThreadId: 1,
      chatId: 1,
      status: "running",
      cwd: "/tmp",
      createdAt: 0,
      updatedAt: 0,
    };

    const events: AcpTurnEvent[] = [
      { type: "turn_started" },
      {
        type: "agent_message_chunk",
        text: "Protocol negotiation is landing on the wrong year.\n\n",
      },
      {
        type: "agent_message_chunk",
        text: "Updating probe helpers next.\n\n",
      },
      {
        type: "tool_call",
        toolCallId: "t1",
        title: "Write `lib/mcp/request.ts`",
      },
      {
        type: "agent_message_chunk",
        text: "Done — re-run the scan.",
      },
      { type: "turn_ended", stopReason: "end_turn" },
    ];

    const runner = createTurnRunner({
      env: {
        config: { operatorUserId: 1 },
        telegram: {} as Environment["telegram"],
        agents: {} as Environment["agents"],
        clock: { now: () => 0 },
        store: {} as Environment["store"],
      },
      working: {
        ensure: async () => {},
        set: async (_s, text) => {
          paints.push(text);
        },
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
    expect(sent[0]!.text).toContain("Protocol negotiation");
    expect(sent[0]!.text).toContain("Updating probe");
    expect(sent[0]!.text).toContain("re-run the scan");
    expect(sent[0]!.notify).toBe(true);
    expect(paints.some((p) => p.includes("Writing"))).toBe(true);
  });
});

describe("turn runner paints tool progress", () => {
  test("tool_call updates working bubble without blocking stream", async () => {
    const paints: string[] = [];
    const session: PersistedSession = {
      sessionKey: "demo/s",
      identity: { repo: "demo", name: "s", agent: "echo" },
      messageThreadId: 1,
      chatId: 1,
      status: "running",
      cwd: "/tmp",
      createdAt: 0,
      updatedAt: 0,
    };

    const events: AcpTurnEvent[] = [
      { type: "turn_started" },
      {
        type: "tool_call",
        toolCallId: "t1",
        title: "spawn_subagent",
        rawInput: { description: "Research Spotify" },
      },
      // same activity label twice → only one paint
      {
        type: "tool_call",
        toolCallId: "t1b",
        title: "spawn_subagent",
        rawInput: { description: "Research Spotify" },
      },
      {
        type: "tool_call",
        toolCallId: "t2",
        title: "get_command_or_subagent_output",
      },
      // completed updates must not spam "Working…"
      { type: "tool_call_update", toolCallId: "t2", status: "completed" },
      { type: "tool_call_update", toolCallId: "t2", status: "completed" },
      { type: "agent_message_chunk", text: "done" },
      { type: "turn_ended", stopReason: "end_turn" },
    ];

    const runner = createTurnRunner({
      env: {
        config: { operatorUserId: 1 },
        telegram: {} as Environment["telegram"],
        agents: {} as Environment["agents"],
        clock: { now: () => 0 },
        store: {} as Environment["store"],
      },
      working: {
        ensure: async () => {},
        set: async (_s, text) => {
          paints.push(text);
        },
        clear: async () => {},
        bump: async () => {},
        messageId: () => undefined,
      },
      sendInTopic: async () => ({ message_id: 1 }),
      setSessionStatus: async () => {},
      log: createLogger({ level: "silent", name: "test" }),
    });

    await runner.drainTurn(session, (async function* () {
      for (const e of events) yield e;
    })());

    // Allow fire-and-forget paints to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(paints.some((p) => p.includes("subagent") && p.includes("Research"))).toBe(
      true,
    );
    expect(paints.some((p) => p.includes("background tasks"))).toBe(true);
    // No spam from completed updates
    expect(paints.filter((p) => p === "Working…")).toHaveLength(0);
    // Identical consecutive labels only painted once
    expect(
      paints.filter((p) => p.includes("Research Spotify")).length,
    ).toBe(1);
  });
});

describe("createWorkingStatus edits in place", () => {
  test("repeated set with same text posts once", async () => {
    const { createWorkingStatus } = await import("../src/core/working-status");
    const { silentLogger } = await import("../src/env/logger");
    const sends: string[] = [];
    const edits: string[] = [];
    let mid = 0;
    const ws = createWorkingStatus({
      log: silentLogger(),
      sendInTopic: async (_s, text) => {
        sends.push(text);
        mid += 1;
        return { message_id: mid };
      },
      telegram: {
        editMessageText: async (p) => {
          edits.push(p.text);
        },
        deleteMessage: async () => {},
      } as Environment["telegram"],
    });
    const session: PersistedSession = {
      sessionKey: "a/b",
      identity: { repo: "a", name: "b", agent: "echo" },
      messageThreadId: 1,
      chatId: 9,
      status: "running",
      cwd: "/tmp",
      createdAt: 0,
      updatedAt: 0,
    };
    await ws.ensure(session, "Working…");
    await ws.set(session, "Running a tool…");
    await ws.set(session, "Running a tool…");
    await ws.set(session, "Running a tool…");
    await ws.set(session, "Waiting on background tasks…");
    expect(sends).toHaveLength(1);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    // last successful edit is the wait label
    expect(edits[edits.length - 1]).toContain("background tasks");
  });

  test("bump deletes and re-posts so bubble can be last again", async () => {
    const { createWorkingStatus } = await import("../src/core/working-status");
    const { silentLogger } = await import("../src/env/logger");
    const sends: string[] = [];
    const deleted: number[] = [];
    let mid = 0;
    const ws = createWorkingStatus({
      log: silentLogger(),
      sendInTopic: async (_s, text, _r, opts) => {
        expect(opts?.workingBubble).toBe(true);
        sends.push(text);
        mid += 1;
        return { message_id: mid };
      },
      telegram: {
        editMessageText: async () => {},
        deleteMessage: async (p) => {
          deleted.push(p.messageId);
        },
      } as Environment["telegram"],
    });
    const session: PersistedSession = {
      sessionKey: "a/b",
      identity: { repo: "a", name: "b", agent: "echo" },
      messageThreadId: 1,
      chatId: 9,
      status: "running",
      cwd: "/tmp",
      createdAt: 0,
      updatedAt: 0,
    };
    await ws.ensure(session, "Working…");
    expect(ws.messageId(session.sessionKey)).toBe(1);
    await ws.set(session, "Running a command…");
    // still same message (edit in place)
    expect(ws.messageId(session.sessionKey)).toBe(1);
    expect(sends).toHaveLength(1);

    await ws.bump(session);
    expect(deleted).toEqual([1]);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain("Running a command");
    expect(ws.messageId(session.sessionKey)).toBe(2);

    // bump with no bubble is a no-op
    await ws.clear(session);
    expect(ws.messageId(session.sessionKey)).toBeUndefined();
    await ws.bump(session);
    expect(sends).toHaveLength(2);
  });

  test("edit failure deletes old bubble before repost", async () => {
    const { createWorkingStatus } = await import("../src/core/working-status");
    const { silentLogger } = await import("../src/env/logger");
    const deleted: number[] = [];
    let mid = 0;
    let edits = 0;
    const ws = createWorkingStatus({
      log: silentLogger(),
      sendInTopic: async () => {
        mid += 1;
        return { message_id: mid };
      },
      telegram: {
        editMessageText: async () => {
          edits += 1;
          if (edits === 1) throw new Error("message to edit not found");
        },
        deleteMessage: async (p) => {
          deleted.push(p.messageId);
        },
      } as Environment["telegram"],
    });
    const session: PersistedSession = {
      sessionKey: "a/b",
      identity: { repo: "a", name: "b", agent: "echo" },
      messageThreadId: 1,
      chatId: 9,
      status: "running",
      cwd: "/tmp",
      createdAt: 0,
      updatedAt: 0,
    };
    await ws.ensure(session, "Working…");
    await ws.set(session, "Next step…");
    expect(deleted).toContain(1);
    expect(ws.messageId(session.sessionKey)).toBe(2);
  });
});
