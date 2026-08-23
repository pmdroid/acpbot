import { describe, expect, test } from "bun:test";
import {
  forceAskFingerprint,
  isComputerUsePermission,
  shouldForceAskPermission,
} from "../src/acp/permission-map";
import {
  sessionHostAutoAllowsPermission,
  sessionHostPromotesBypass,
} from "../src/acp/session-host";
import { acpHostAutoAllowsPermission } from "../src/acp-host/server";
import {
  createDaemon,
  daemonAutoAllowsPermission,
} from "../src/core/daemon";
import { createFakeEnvironment } from "../src/env/fake-env";
import type { TelegramUpdate } from "../src/env/types";

const COMPUTER_RAW = {
  toolCallId: "c-1",
  toolCall: { title: "computer_screenshot", kind: "other", toolCallId: "c-1" },
};
const SHELL_RAW = {
  toolCallId: "s-1",
  toolCall: { title: "run_terminal_command", kind: "execute" },
};
const PLAN_RAW = {
  toolCall: { title: "Plan: Exit", rawInput: { variant: "ExitPlanMode" } },
};

describe("isComputerUsePermission", () => {
  test("detects computer_* titles and kinds", () => {
    expect(isComputerUsePermission(COMPUTER_RAW)).toBe(true);
    expect(
      isComputerUsePermission({
        toolCall: { title: "computer_click", kind: "computer_click" },
      }),
    ).toBe(true);
    expect(
      isComputerUsePermission({
        toolCallId: "computer_type-abc",
        toolCall: { title: "Type" },
      }),
    ).toBe(true);
    expect(isComputerUsePermission(SHELL_RAW)).toBe(false);
    expect(isComputerUsePermission(PLAN_RAW)).toBe(false);
  });

  test("description-only title with [computer] / /computer is computer-use", () => {
    const descOnly = {
      toolCallId: "uuid-no-name",
      toolCall: {
        title:
          "Capture the isolated browser viewport for this topic. Requires [computer].enabled and `/computer on`.",
        kind: "other",
      },
    };
    expect(isComputerUsePermission(descOnly)).toBe(true);
    expect(shouldForceAskPermission(descOnly)).toBe(true);
    expect(sessionHostAutoAllowsPermission("bypass", descOnly)).toBe(false);
  });

  test("MCP name / _meta name is computer-use", () => {
    expect(
      isComputerUsePermission({
        toolCallId: "uuid-2",
        toolCall: {
          title: "Capture viewport",
          name: "computer_screenshot",
        },
      }),
    ).toBe(true);
    expect(
      isComputerUsePermission({
        toolCallId: "uuid-3",
        toolCall: {
          title: "Capture viewport",
          _meta: { "x.ai/tool": { name: "computer_click" } },
        },
      }),
    ).toBe(true);
  });

  test("shouldForceAskPermission covers plan-exit and computer-use", () => {
    expect(shouldForceAskPermission(COMPUTER_RAW)).toBe(true);
    expect(shouldForceAskPermission(PLAN_RAW)).toBe(true);
    expect(shouldForceAskPermission(SHELL_RAW)).toBe(false);
  });
});

describe("site 1: session-host bypass", () => {
  test("bypass does not auto-allow computer-use; unique confirm is not bypass-promoted", () => {
    expect(sessionHostAutoAllowsPermission("bypass", COMPUTER_RAW)).toBe(false);
    expect(sessionHostAutoAllowsPermission("bypass", PLAN_RAW)).toBe(false);
    expect(sessionHostAutoAllowsPermission("bypass", SHELL_RAW)).toBe(true);
    expect(sessionHostAutoAllowsPermission("ask", COMPUTER_RAW)).toBe(false);
    expect(sessionHostPromotesBypass(COMPUTER_RAW)).toBe(false);
    expect(sessionHostPromotesBypass(SHELL_RAW)).toBe(true);
  });

  test("forceAskFingerprint is unique per toolCallId (session-host uses this)", () => {
    const a = forceAskFingerprint("demo/box", "c-1", COMPUTER_RAW);
    const b = forceAskFingerprint("demo/box", "c-2", COMPUTER_RAW);
    expect(a).toBe("computer:demo/box:c-1");
    expect(b).toBe("computer:demo/box:c-2");
    expect(a).not.toBe(b);
    expect(forceAskFingerprint("demo/box", "c-1", PLAN_RAW)).toBe(
      "plan-exit:demo/box:c-1",
    );
    expect(forceAskFingerprint("demo/box", "s-1", SHELL_RAW)).toBeUndefined();
  });
});

describe("site 2: acp-host hooks bypass", () => {
  test("bypass does not auto-allow computer-use before the worker", () => {
    expect(acpHostAutoAllowsPermission("bypass", COMPUTER_RAW)).toBe(false);
    expect(acpHostAutoAllowsPermission("bypass", PLAN_RAW)).toBe(false);
    expect(acpHostAutoAllowsPermission("bypass", SHELL_RAW)).toBe(true);
    expect(acpHostAutoAllowsPermission("ask", SHELL_RAW)).toBe(false);
  });
});

describe("site 3: daemon handlePermissionRequest", () => {
  test("bypass helper matches the other two sites", () => {
    expect(daemonAutoAllowsPermission("bypass", COMPUTER_RAW)).toBe(false);
    expect(daemonAutoAllowsPermission("bypass", SHELL_RAW)).toBe(true);
  });

  test("bypass session still shows Telegram UI for computer-use", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: 42,
        operatorChatId: 1000,
        repos: { acpbot: "/configured/repos/acpbot" },
        permissionMode: "bypass",
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "/new acpbot perm",
        from: { id: 42, first_name: "op" },
        chat: { id: 1000, type: "private" },
      },
    } satisfies TelegramUpdate);
    const session = (await daemon.listSessions())[0]!;
    session.permissionMode = "bypass";
    env.telegram.clearOutbound();

    const pending = env.agents.raisePermission({
      sessionId: session.sessionKey,
      toolCallId: "c-1",
      raw: {
        options: [
          { optionId: "yes", name: "Allow once", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
        ...COMPUTER_RAW,
      },
    });

    let prompt:
      | (ReturnType<typeof env.telegram.sentMessages>[number] & {
          message_id: number;
        })
      | undefined;
    for (let i = 0; i < 40; i++) {
      prompt = env.telegram
        .sentMessages()
        .find((m) => (m.text ?? "").includes("Permission") || (m.text ?? "").includes("computer"));
      if (prompt?.replyMarkup) break;
      await Bun.sleep(15);
    }
    expect(prompt).toBeDefined();
    expect(prompt?.replyMarkup).toBeDefined();

    const markup = prompt!.replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const allow = markup.inline_keyboard.flat()[0]!;
    await daemon.handleUpdate({
      update_id: 9,
      callback_query: {
        id: "cq-9",
        from: { id: 42, first_name: "op" },
        data: allow.callback_data,
        message: {
          message_id: prompt!.message_id,
          date: 0,
          chat: { id: 1000, type: "private" },
          message_thread_id: session.messageThreadId,
          is_topic_message: true,
        },
      },
    });
    const decision = await pending;
    expect(decision?.outcome).toBe("allow_once");
    expect(session.permissionMode).toBe("bypass");
  });

  test("ordinary tool on bypass is auto-allowed (control)", async () => {
    const env = createFakeEnvironment({
      config: {
        operatorUserId: 42,
        operatorChatId: 1000,
        repos: { acpbot: "/configured/repos/acpbot" },
        permissionMode: "bypass",
      },
    });
    const daemon = createDaemon(env);
    await daemon.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "/new acpbot shell",
        from: { id: 42, first_name: "op" },
        chat: { id: 1000, type: "private" },
      },
    } satisfies TelegramUpdate);
    const session = (await daemon.listSessions())[0]!;
    session.permissionMode = "bypass";
    env.telegram.clearOutbound();

    const decision = await env.agents.raisePermission({
      sessionId: session.sessionKey,
      toolCallId: "s-1",
      raw: SHELL_RAW,
    });
    expect(decision).toEqual({ outcome: "allow_always" });
    expect(env.telegram.sentMessages().length).toBe(0);
  });
});
