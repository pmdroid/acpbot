import { describe, expect, test } from "bun:test";
import {
  pickReadOnlyModeId,
  pickSessionModeId,
  realAgents,
} from "../src/env/real-agents";
import type { SessionHost, HostTurn } from "../src/acp/session-host";

describe("pickSessionModeId", () => {
  test("default prefers ask / permission-cautious modes", () => {
    expect(pickSessionModeId(["default", "ask", "full"])).toBe("ask");
    expect(pickSessionModeId(["default", "read-only", "full"])).toBe("default");
    expect(pickSessionModeId(["read-only", "ask"])).toBe("ask");
    expect(pickSessionModeId(["agent", "read-only"])).toBe("read-only");
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
      async getModeState() {
        return { currentModeId: "build", availableModeIds: ["build"] };
      },
      async getAvailableModes() {
        return ["build"];
      },
      async getConfigOptions() {
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
        repos: { acpbot: "/configured/repos/acpbot" },
        defaultAgent: "grok-build",
      },
      stateDir: "/state",
      host,
    });

    const session = await agents.ensureSession({
      repo: "acpbot",
      name: "x",
    });
    expect(session.cwd).toBe("/configured/repos/acpbot");

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

  test("getSessionMode/config always query host (no stale local skip)", async () => {
    let modeCalls = 0;
    let configCalls = 0;
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
      startTurn() {
        throw new Error("not used");
      },
      async cancel() {},
      async setMode() {
        return { currentModeId: "build", availableModeIds: ["build"] };
      },
      async getModeState() {
        modeCalls++;
        return {
          currentModeId: "build",
          availableModeIds: ["build", "plan"],
        };
      },
      async getAvailableModes() {
        return ["build", "plan"];
      },
      async getConfigOptions() {
        configCalls++;
        return [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "grok-4.5",
            options: [{ value: "grok-4.5", name: "Grok 4.5" }],
          },
        ];
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
        repos: { acpbot: "/tmp/acpbot" },
        defaultAgent: "grok-build",
      },
      stateDir: "/state",
      host,
    });

    const m1 = await agents.getSessionMode!("demo/x");
    const m2 = await agents.getSessionMode!("demo/x");
    expect(modeCalls).toBe(2);
    expect(m1.currentModeId).toBe("build");
    expect(m2.availableModeIds).toContain("plan");

    const c1 = await agents.getSessionConfigOptions!("demo/x");
    const c2 = await agents.getSessionConfigOptions!("demo/x");
    expect(configCalls).toBe(2);
    expect(c1[0]?.currentValue).toBe("grok-4.5");
    expect(c2).toHaveLength(1);
  });
});
