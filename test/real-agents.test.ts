import { describe, expect, test } from "bun:test";
import {
  buildAcpRuntimeOptions,
  pickReadOnlyModeId,
  realAgents,
  type Runtime,
  type RuntimeHandle,
} from "../src/env/real-agents";

describe("buildAcpRuntimeOptions (shipped option builder)", () => {
  test("never includes timeoutMs and always supplies store + registry", () => {
    const opts = buildAcpRuntimeOptions({
      config: {
        operatorUserId: 1,
        repos: { tacp: "/r/tacp" },
      },
      acpxStateDir: "/state",
      sessionStore: { load: async () => undefined, save: async () => {} },
      agentRegistry: { resolve: () => "x", list: () => [] },
      onPermissionRequest: async () => ({ outcome: "reject_once" }),
      onElicitationRequest: async () => ({ action: "decline" }),
    });
    expect("timeoutMs" in opts).toBe(false);
    expect(opts.sessionStore).toBeDefined();
    expect(opts.agentRegistry).toBeDefined();
    expect(opts.permissionMode).toBe("approve-all");
    expect(opts.nonInteractivePermissions).toBe("deny");
    expect(opts.cwd).toBe("/r/tacp");
  });

  test("forwards onAskUserQuestion so AcpClient does not methodNotFound", async () => {
    const ask = async () => ({ answers: [{ questionId: "q1", selectedOptionIds: ["a"] }] });
    const opts = buildAcpRuntimeOptions({
      config: { operatorUserId: 1, repos: { tacp: "/r/tacp" } },
      acpxStateDir: "/state",
      sessionStore: {},
      agentRegistry: {},
      onPermissionRequest: async () => ({ outcome: "reject_once" }),
      onElicitationRequest: async () => ({ action: "decline" }),
      onAskUserQuestion: ask,
    });
    // Regression: builder used to drop this key → Method not found: _x.ai/ask_user_question
    expect(typeof opts.onAskUserQuestion).toBe("function");
    expect(opts.onAskUserQuestion).toBe(ask);
    const result = await (
      opts.onAskUserQuestion as () => Promise<Record<string, unknown>>
    )();
    expect(result).toEqual({
      answers: [{ questionId: "q1", selectedOptionIds: ["a"] }],
    });
  });
});

describe("pickSessionModeId", () => {
  test("default prefers interactive modes over read-only", async () => {
    const { pickSessionModeId } = await import("../src/env/real-agents");
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

describe("realAgents with injected runtime (shipped port)", () => {
  test("ensureSession prefers non-read-only mode; startTurn has no timeoutMs", async () => {
    const setModes: string[] = [];
    const startTurnInputs: unknown[] = [];

    const handle: RuntimeHandle = {
      sessionKey: "tacp/x",
      backend: "acpx",
      runtimeSessionName: "name",
      cwd: "/configured/repos/tacp",
      agentSessionId: "sid",
    };

    const runtime: Runtime = {
      async ensureSession() {
        return handle;
      },
      startTurn(input) {
        startTurnInputs.push(input);
        return {
          events: (async function* () {
            yield { type: "text_delta", text: "hi", stream: "output" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        };
      },
      async setMode({ mode }) {
        setModes.push(mode);
      },
      async getStatus() {
        return {
          details: {
            availableModeIds: ["full", "read-only", "ask"],
          },
        };
      },
    };

    const agents = realAgents({
      config: {
        operatorUserId: 1,
        repos: { tacp: "/configured/repos/tacp" },
        defaultAgent: "codex",
      },
      acpxStateDir: "/state",
      runtime,
    });

    const session = await agents.ensureSession({
      repo: "tacp",
      name: "x",
    });
    expect(session.cwd).toBe("/configured/repos/tacp");
    // ask/full/default — not read-only — so terminal stays available
    expect(setModes[0]).not.toBe("read-only");
    expect(["ask", "full", "default"]).toContain(setModes[0]);

    const turn = await agents.runPromptTurn(session, { text: "go" });
    const texts: string[] = [];
    for await (const ev of turn.events) {
      if (ev.type === "agent_message_chunk") texts.push(ev.text);
    }
    expect(texts.join("")).toContain("hi");
    expect(startTurnInputs).toHaveLength(1);
    const arg = startTurnInputs[0] as Record<string, unknown>;
    expect("timeoutMs" in arg).toBe(false);
    expect(arg.text).toBe("go");
  });

  test("default permission handler rejects rather than hanging", async () => {
    const opts = buildAcpRuntimeOptions({
      config: { operatorUserId: 1 },
      acpxStateDir: "/s",
      sessionStore: {},
      agentRegistry: {},
      onPermissionRequest: async () => ({ outcome: "reject_once" }),
      onElicitationRequest: async () => ({ action: "decline" }),
    });
    const decision = await (
      opts.onPermissionRequest as (r: unknown, c: unknown) => Promise<unknown>
    )({ sessionId: "s", raw: {} }, { signal: new AbortController().signal });
    expect(decision).toEqual({ outcome: "reject_once" });
  });
});

describe("contract: createAcpRuntime from local fork", () => {
  test("creates runtime with store + registry without timeoutMs", async () => {
    const mod = await import("acpx/runtime");
    const stateDir = `${import.meta.dir}/../.scratch-acpx-contract`;
    await Bun.write(`${stateDir}/.keep`, "");
    const opts = buildAcpRuntimeOptions({
      config: { operatorUserId: 1, repos: { t: stateDir } },
      acpxStateDir: stateDir,
      sessionStore: mod.createRuntimeStore({ stateDir }),
      agentRegistry: mod.createAgentRegistry(),
      onPermissionRequest: async () => ({ outcome: "reject_once" }),
      onElicitationRequest: async () => ({ action: "decline" }),
    });
    expect("timeoutMs" in opts).toBe(false);
    const runtime = mod.createAcpRuntime(opts);
    expect(runtime).toBeDefined();
    expect(typeof runtime.ensureSession).toBe("function");
    expect(typeof runtime.startTurn).toBe("function");
  });
});
