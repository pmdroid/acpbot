import { describe, expect, test } from "bun:test";
import {
  contentToText,
  latestUserText,
  parseModelId,
} from "../src/openai-gateway/types";
import { buildModelCatalog } from "../src/openai-gateway/models";
import { parseOpenAiGatewayToml } from "../src/openai-gateway/server";
import { runCompletion } from "../src/openai-gateway/completions";
import type { ChatHost } from "../src/chat/turn";
import type { HostTurn, HostTurnEvent } from "../src/acp/session-host";

describe("parseModelId", () => {
  test("repo/agent", () => {
    expect(parseModelId("acpbot/demo/grok-build")).toEqual({
      sessionKey: "demo/main",
      agent: "grok-build",
    });
  });

  test("repo/agent/name", () => {
    expect(parseModelId("acpbot/demo/grok-build/chat")).toEqual({
      sessionKey: "demo/chat",
      agent: "grok-build",
    });
  });

  test("agent-only needs default_repo", () => {
    expect(parseModelId("acpbot/grok-build", "demo")).toEqual({
      sessionKey: "demo/main",
      agent: "grok-build",
    });
    expect(() => parseModelId("acpbot/grok-build")).toThrow(/default_repo/);
  });
});

describe("latestUserText", () => {
  test("picks last user message", () => {
    expect(
      latestUserText([
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
  });

  test("content parts", () => {
    expect(
      contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    ).toBe("ab");
  });
});

describe("buildModelCatalog", () => {
  test("repos × agents", () => {
    const models = buildModelCatalog({
      repos: { demo: "/tmp/demo", other: "/tmp/o" },
      agents: ["grok-build"],
      repoKeys: ["demo"],
    });
    expect(models.map((m) => m.id)).toEqual(["acpbot/demo/grok-build"]);
  });
});

describe("parseOpenAiGatewayToml", () => {
  test("disabled by default", () => {
    expect(parseOpenAiGatewayToml({ enabled: false })).toBeUndefined();
  });

  test("requires token when enabled", () => {
    expect(() =>
      parseOpenAiGatewayToml({ enabled: true }, {}),
    ).toThrow(/token/);
  });

  test("env token", () => {
    const cfg = parseOpenAiGatewayToml(
      { enabled: true, token: "env:MY_TOK" },
      { MY_TOK: "secret" },
    );
    expect(cfg?.token).toBe("secret");
    expect(cfg?.listenPort).toBe(8791);
  });
});

describe("runCompletion", () => {
  function fakeHost(script: HostTurnEvent[]): ChatHost {
    return {
      async ensureSession(input) {
        return {
          sessionKey: input.sessionKey,
          agentSessionId: "s",
          cwd: input.cwd,
          agent: input.agent,
          currentModeId: "default",
          availableModeIds: ["default"],
          configOptions: [],
        };
      },
      startTurn() {
        const events = (async function* () {
          for (const ev of script) yield ev;
        })();
        return {
          events,
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        } satisfies HostTurn;
      },
      async cancel() {},
    };
  }

  test("non-stream completion", async () => {
    const host = fakeHost([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: "!" },
    ]);
    const res = await runCompletion(
      {
        host,
        repos: { demo: "/tmp/demo" },
        defaultAgent: "grok-build",
        permissionMode: "bypass",
      },
      {
        model: "acpbot/demo/grok-build",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]!.message.content).toBe("Hello!");
  });

  test("stream SSE", async () => {
    const host = fakeHost([{ type: "text_delta", text: "x" }]);
    const res = await runCompletion(
      {
        host,
        repos: { demo: "/tmp/demo" },
        defaultAgent: "grok-build",
        permissionMode: "bypass",
      },
      {
        model: "acpbot/demo/grok-build",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    );
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
  });

  test("rejects unknown repo", async () => {
    const host = fakeHost([]);
    const res = await runCompletion(
      {
        host,
        repos: {},
        defaultAgent: "grok-build",
        permissionMode: "bypass",
      },
      {
        model: "acpbot/missing/grok-build",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    );
    expect(res.status).toBe(400);
  });
});
