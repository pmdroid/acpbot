import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  commandAllowedIn,
  isKnownCommand,
  lobbyHelpText,
  normalizeCommandToken,
  parseSlashCommand,
  resolveCanonicalName,
  topicHelpText,
} from "../src/core/commands";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";

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

describe("command registry", () => {
  test("canonical set is small and documented", () => {
    const names = COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual([
      "/agent",
      "/build",
      "/cancel",
      "/effort",
      "/eve",
      "/fresh",
      "/help",
      "/linear",
      "/mcp",
      "/mode",
      "/model",
      "/new",
      "/permissions",
      "/ping",
      "/plan",
      "/queue",
      "/sessions",
      "/skills",
      "/status",
      "/steer",
      "/unqueue",
    ]);
  });

  test("normalizes bot-suffixed tokens and legacy /list", () => {
    expect(normalizeCommandToken("/ping@UrsulaMa_Bot")).toBe("/ping");
    expect(resolveCanonicalName("/Sessions")).toBe("/sessions");
    expect(resolveCanonicalName("/list")).toBe("/sessions");
    expect(parseSlashCommand("/new@bot demo scratch")?.name).toBe("/new");
    expect(parseSlashCommand("/new@bot demo scratch")?.args).toEqual([
      "demo",
      "scratch",
    ]);
  });

  test("scope checks", () => {
    expect(commandAllowedIn("/ping", "lobby")).toBe(true);
    expect(commandAllowedIn("/ping", "topic")).toBe(false);
    expect(commandAllowedIn("/cancel", "topic")).toBe(true);
    expect(commandAllowedIn("/cancel", "lobby")).toBe(false);
    expect(commandAllowedIn("/fresh", "topic")).toBe(true);
    expect(commandAllowedIn("/fresh", "lobby")).toBe(false);
    expect(resolveCanonicalName("/reset")).toBe("/fresh");
    expect(commandAllowedIn("/steer", "topic")).toBe(true);
    expect(commandAllowedIn("/queue", "topic")).toBe(true);
    expect(commandAllowedIn("/unqueue", "topic")).toBe(true);
    expect(commandAllowedIn("/plan", "topic")).toBe(true);
    expect(commandAllowedIn("/build", "topic")).toBe(true);
    expect(commandAllowedIn("/mode", "lobby")).toBe(false);
    expect(commandAllowedIn("/help", "lobby")).toBe(true);
    expect(commandAllowedIn("/help", "topic")).toBe(true);
  });

  test("help texts only list scoped commands", () => {
    const lobby = lobbyHelpText();
    expect(lobby).toContain("/ping");
    expect(lobby).toContain("/new");
    expect(lobby).toContain("/sessions");
    expect(lobby).not.toMatch(/^\/cancel/m);
    expect(lobby).not.toContain("/skills");
    // /list is not advertised
    expect(lobby).not.toContain("/list");

    const topic = topicHelpText();
    expect(topic).toContain("/cancel");
    expect(topic).toContain("/fresh");
    expect(topic).toContain("/steer");
    expect(topic).toContain("/queue");
    expect(topic).toContain("/unqueue");
    expect(topic).toContain("/help");
    expect(topic).toContain("/skills");
    expect(topic).toContain("/plan");
    expect(topic).toContain("/build");
    expect(topic).toContain("/mode");
    expect(topic).toContain("/effort");
    expect(topic).toContain("/mcp");
    expect(topic).toMatch(/queued/i);
    expect(topic).toMatch(/interrupt/i);
    expect(topic).not.toContain("/new —");
  });

  test("/skills is topic-only", () => {
    expect(commandAllowedIn("/skills", "topic")).toBe(true);
    expect(commandAllowedIn("/skills", "lobby")).toBe(false);
  });
});

describe("command routing cleanup", () => {
  test("lobby /list still works as silent alias of /sessions", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo a", 1));
    await daemon.handleUpdate(root("/list", 2));
    const reply = env.telegram
      .sentMessages()
      .find((m) => m.text?.includes("demo/a"));
    expect(reply).toBeDefined();
  });

  test("topic does not send lobby commands to the agent", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo x", 1));
    const session = (await daemon.listSessions())[0]!;
    const before = env.agents.turns.length;

    await daemon.handleUpdate(topic(session.messageThreadId, "/new", 2));
    await daemon.handleUpdate(topic(session.messageThreadId, "/ping", 3));
    await daemon.handleUpdate(topic(session.messageThreadId, "/sessions", 4));
    await daemon.handleUpdate(topic(session.messageThreadId, "/nope", 5));

    expect(env.agents.turns.length).toBe(before);
    const topicTexts = env.telegram
      .sentMessages()
      .filter((m) => m.messageThreadId === session.messageThreadId)
      .map((m) => m.text ?? "");
    expect(topicTexts.some((t) => t.includes("lobby command"))).toBe(true);
    expect(topicTexts.some((t) => t.includes("Unknown command"))).toBe(true);
  });

  test("lobby rejects /cancel with scope message", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/cancel", 1));
    const msg = env.telegram.sentMessages().find((m) =>
      m.text?.includes("session topic"),
    );
    expect(msg).toBeDefined();
  });

  test("topic /fresh requests forceNewSession and keeps topic", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/new demo keep", 1));
    const session = (await daemon.listSessions())[0]!;
    const beforeCalls = env.agents.ensureCalls.length;
    const beforeOpts = env.agents.ensureOpts.length;

    await daemon.handleUpdate(topic(session.messageThreadId, "/fresh", 2));

    expect(env.agents.ensureCalls.length).toBeGreaterThan(beforeCalls);
    const opts = env.agents.ensureOpts.slice(beforeOpts);
    expect(opts.some((o) => o.forceNewSession === true)).toBe(true);

    const after = (await daemon.listSessions())[0]!;
    expect(after.sessionKey).toBe(session.sessionKey);
    expect(after.messageThreadId).toBe(session.messageThreadId);

    const reply = env.telegram
      .sentMessages()
      .filter((m) => m.messageThreadId === session.messageThreadId)
      .map((m) => m.text ?? "")
      .find((t) => /Fresh session/i.test(t));
    expect(reply).toBeDefined();

    // Alias /reset resolves to the same command.
    await daemon.handleUpdate(topic(session.messageThreadId, "/reset", 3));
    expect(
      env.agents.ensureOpts.filter((o) => o.forceNewSession).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("lobby rejects /fresh with scope message", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        operatorChatId: CHAT,
        repos: { demo: "/configured/repos/demo" },
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate(root("/fresh", 1));
    const msg = env.telegram.sentMessages().find((m) =>
      m.text?.includes("session topic"),
    );
    expect(msg).toBeDefined();
  });

  test("isKnownCommand", () => {
    expect(isKnownCommand("/ping")).toBe(true);
    expect(isKnownCommand("/list")).toBe(true);
    expect(isKnownCommand("/fresh")).toBe(true);
    expect(isKnownCommand("/nope")).toBe(false);
  });
});
