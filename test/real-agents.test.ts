import { describe, expect, test } from "bun:test";
import {
  pickReadOnlyModeId,
  pickSessionModeId,
  realAgents,
} from "../src/env/real-agents";
import type { SessionHost, HostTurn } from "../src/acp/session-host";

describe("pickSessionModeId", () => {
  test("default prefers interactive modes over read-only", () => {
    expect(pickSessionModeId(["default", "read-only", "full"])).toBe("default");
    expect(pickSessionModeId(["read-only", "ask"])).toBe("ask");
    expect(pickSessionModeId(["read-only", "plan"])).toBe("read-only");
  });

  test("forceReadOnly still prefers read-only", () => {
    expect(pickReadOnlyModeId(["default", "read-only", "full"])).toBe(
      "read-only",
    );
    expect(pickReadOnlyModeId([])).toBe("read-only");
  });
});

describe("realAgents with injected host", () => {
  test("ensureSession + startTurn maps text; no timeoutMs", async () => {
    const startInputs: unknown[] = [];

    const host: SessionHost = {
      setHooks() {},
      async ensureSession(input) {
        return {
          sessionKey: input.sessionKey,
          agentSessionId: "sid-1",
          cwd: input.cwd,
          agent: input.agent,
        };
      },
      startTurn(input) {
        startInputs.push(input);
        const turn: HostTurn = {
          events: (async function* () {
            yield { type: "text_delta", text: "hi", stream: "output" };
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({
            status: "completed",
            stopReason: "end_turn",
          }),
          cancel: async () => {},
        };
        return turn;
      },
      async cancel() {},
      async setMode() {
        return { currentModeId: "build", availableModeIds: ["build"] };
      },
      getModeState() {
        return { currentModeId: "build", availableModeIds: ["build"] };
      },
      getAvailableModes() {
        return ["build"];
      },
      getConfigOptions() {
        return [];
      },
      async setConfigOption() {
        return [];
      },
      async disposeSession() {},
      async dispose() {},
    };

    const agents = realAgents({
      config: {
        operatorUserId: 1,
        repos: { tacp: "/configured/repos/tacp" },
        defaultAgent: "grok-build",
      },
      stateDir: "/state",
      host,
    });

    const session = await agents.ensureSession({
      repo: "tacp",
      name: "x",
    });
    expect(session.cwd).toBe("/configured/repos/tacp");

    const turn = await agents.runPromptTurn(session, { text: "go" });
    const texts: string[] = [];
    for await (const ev of turn.events) {
      if (ev.type === "agent_message_chunk") texts.push(ev.text);
    }
    expect(texts.join("")).toContain("hi");
    expect(startInputs).toHaveLength(1);
    const arg = startInputs[0] as Record<string, unknown>;
    expect("timeoutMs" in arg).toBe(false);
    expect(arg.text).toBe("go");
  });
});
