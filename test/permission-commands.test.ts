import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";
import {
  encodePermissionModeCallback,
  parsePermissionModeCallback,
} from "../src/core/callbacks";
import {
  replacePermissionModeInToml,
  writePermissionModeToConfig,
} from "../src/setup/permission-toml";

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

function topic(threadId: number, text: string, id: number): TelegramUpdate {
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

function callback(
  data: string,
  id: number,
  messageId: number,
  threadId?: number,
): TelegramUpdate {
  return {
    update_id: id,
    callback_query: {
      id: String(id),
      data,
      from: { id: OPERATOR, first_name: "op" },
      message: {
        message_id: messageId,
        date: 0,
        chat: { id: CHAT, type: "private" },
        ...(threadId !== undefined
          ? { message_thread_id: threadId, is_topic_message: true }
          : {}),
      },
    },
  };
}

describe("permission mode callback codec", () => {
  test("round-trip ask/bypass indices", () => {
    const a = encodePermissionModeCallback("deadbeef", 0);
    const b = encodePermissionModeCallback("deadbeef", 1);
    expect(a.startsWith("R:")).toBe(true);
    expect(parsePermissionModeCallback(a)).toEqual({
      token: "deadbeef",
      modeIndex: 0,
    });
    expect(parsePermissionModeCallback(b)).toEqual({
      token: "deadbeef",
      modeIndex: 1,
    });
    expect(parsePermissionModeCallback("p:token:0")).toBeUndefined();
  });
});

describe("replacePermissionModeInToml", () => {
  test("updates features.permission_mode", () => {
    const body = `[features]
mcp = true
permission_mode = "ask"  # ask | bypass
tts_mode = "agent"
`;
    const next = replacePermissionModeInToml(body, "bypass");
    expect(next).toMatch(/permission_mode = "bypass"/);
    expect(next).toMatch(/mcp = true/);
    expect(next).toMatch(/tts_mode = "agent"/);
  });

  test("inserts into empty features section", () => {
    const body = `bot_token = "t"\n\n[features]\nmcp = true\n`;
    const next = replacePermissionModeInToml(body, "bypass");
    expect(next).toMatch(/\[features\]/);
    expect(next).toMatch(/permission_mode = "bypass"/);
  });

  test("creates features when missing", () => {
    const body = `bot_token = "t"\n\n[repos]\ndemo = "/tmp"\n`;
    const next = replacePermissionModeInToml(body, "ask");
    expect(next).toMatch(/\[features\]/);
    expect(next).toMatch(/permission_mode = "ask"/);
  });
});

describe("/permissions slash + buttons", () => {
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "acpbot-perm-"));
    configPath = join(stateDir, "config.toml");
    writeFileSync(
      configPath,
      `bot_token = "t"\n\n[features]\nmcp = true\npermission_mode = "ask"\n`,
      "utf8",
    );
  });

  afterEach(() => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  test("bare /permissions in topic shows Ask and Bypass buttons", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
        permissionMode: "ask",
      },
    });
    const d = createDaemon(env, { stateDir, configPath });
    await d.handleUpdate(root("/new demo permsess", 1));
    const sessions = await d.listSessions();
    const tid = sessions[0]!.messageThreadId;

    env.telegram.clearOutbound();
    await d.handleUpdate(topic(tid, "/permissions", 2));

    const msgs = env.telegram.sentMessages();
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const last = msgs[msgs.length - 1]!;
    expect(last.text).toMatch(/Permissions/i);
    const kb = last.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(kb?.inline_keyboard).toBeDefined();
    const flat = kb.inline_keyboard.flat();
    expect(flat.some((b) => /Ask/i.test(b.text))).toBe(true);
    expect(flat.some((b) => /Bypass/i.test(b.text))).toBe(true);
    expect(flat.every((b) => b.callback_data.startsWith("R:"))).toBe(true);
  });

  test("topic button sets session permissionMode", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
        permissionMode: "ask",
      },
    });
    const d = createDaemon(env, { stateDir, configPath });
    await d.handleUpdate(root("/new demo permbtn", 1));
    const sessions = await d.listSessions();
    const tid = sessions[0]!.messageThreadId;
    const key = sessions[0]!.sessionKey;

    env.telegram.clearOutbound();
    await d.handleUpdate(topic(tid, "/permissions", 2));
    const last = env.telegram.sentMessages().at(-1)!;
    const kb = last.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const bypassBtn = kb.inline_keyboard
      .flat()
      .find((b) => /Bypass/i.test(b.text));
    expect(bypassBtn).toBeDefined();

    await d.handleUpdate(
      callback(bypassBtn!.callback_data, 3, last.message_id!, tid),
    );

    const after = await d.listSessions();
    const sess = after.find((s) => s.sessionKey === key);
    expect(sess?.permissionMode).toBe("bypass");
  });

  test("/permissions default bypass writes config.toml", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        repos: { demo: "/tmp/demo-repo" },
        permissionMode: "ask",
      },
    });
    const d = createDaemon(env, { stateDir, configPath });
    await d.handleUpdate(root("/permissions default bypass", 1));

    const body = readFileSync(configPath, "utf8");
    expect(body).toMatch(/permission_mode = "bypass"/);
    expect(env.config.permissionMode).toBe("bypass");

    const stateFile = readFileSync(
      join(stateDir, "permission-mode.json"),
      "utf8",
    );
    expect(JSON.parse(stateFile).permissionMode).toBe("bypass");
  });

  test("lobby bare /permissions buttons set default + config", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: OPERATOR,
        permissionMode: "ask",
      },
    });
    const d = createDaemon(env, { stateDir, configPath });
    env.telegram.clearOutbound();
    await d.handleUpdate(root("/permissions", 1));
    const last = env.telegram.sentMessages().at(-1)!;
    const kb = last.replyMarkup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const bypassBtn = kb.inline_keyboard
      .flat()
      .find((b) => /Bypass/i.test(b.text));
    expect(bypassBtn).toBeDefined();

    await d.handleUpdate(
      callback(bypassBtn!.callback_data, 2, last.message_id!),
    );

    expect(env.config.permissionMode).toBe("bypass");
    const body = readFileSync(configPath, "utf8");
    expect(body).toMatch(/permission_mode = "bypass"/);
  });

  test("writePermissionModeToConfig is idempotent-ish", () => {
    writePermissionModeToConfig(configPath, "bypass");
    writePermissionModeToConfig(configPath, "ask");
    const body = readFileSync(configPath, "utf8");
    expect(body).toMatch(/permission_mode = "ask"/);
    expect(body.match(/permission_mode/g)?.length).toBe(1);
  });
});
