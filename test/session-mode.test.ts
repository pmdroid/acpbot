import { describe, expect, test } from "bun:test";
import {
  extractSessionModes,
  formatSessionStatus,
  isPlanLikeMode,
  resolveBuildModeId,
  resolveModeToken,
  resolvePlanModeId,
  togglePlanBuildModeId,
} from "../src/acp/session-mode";

describe("session mode resolve", () => {
  const available = ["plan", "build", "default"];

  test("plan/build resolution", () => {
    expect(resolvePlanModeId(available)).toBe("plan");
    expect(resolveBuildModeId(available)).toBe("build");
    expect(isPlanLikeMode("plan")).toBe(true);
    expect(isPlanLikeMode("build")).toBe(false);
  });

  test("tokens and toggle", () => {
    expect(resolveModeToken("plan", available)).toBe("plan");
    expect(resolveModeToken("code", available)).toBe("build");
    expect(togglePlanBuildModeId("plan", available)).toBe("build");
    expect(togglePlanBuildModeId("build", available)).toBe("plan");
  });

  test("fallback when only plan-like exists", () => {
    expect(resolveBuildModeId(["plan", "read-only"])).toBeUndefined();
    expect(resolvePlanModeId(["default", "full"])).toBeUndefined();
    expect(resolveBuildModeId(["default", "full"])).toBe("default");
  });
});

describe("extractSessionModes", () => {
  test("Codex-style ACP modes", () => {
    const v = extractSessionModes({
      modes: {
        availableModes: [
          { id: "read-only", name: "Read-only" },
          { id: "agent", name: "Agent" },
          { id: "agent-full-access", name: "Full" },
        ],
        currentModeId: "agent",
      },
    });
    expect(v.source).toBe("acp.modes");
    expect(v.currentModeId).toBe("agent");
    expect(v.availableModeIds).toEqual([
      "read-only",
      "agent",
      "agent-full-access",
    ]);
  });

  test("Grok x.ai/sessionConfig effort is NOT session modes (no agent)", () => {
    const v = extractSessionModes({
      modes: null,
      meta: {
        "x.ai/sessionConfig": {
          options: [
            {
              id: "grok-4.5",
              category: "model",
              label: "Grok 4.5",
              selected: true,
            },
            {
              id: "high",
              category: "mode",
              label: "High Effort",
              selected: true,
            },
            {
              id: "medium",
              category: "mode",
              label: "Medium Effort",
              selected: false,
            },
            {
              id: "low",
              category: "mode",
              label: "Low Effort",
              selected: false,
            },
          ],
        },
      },
    });
    // Without agent id, effort alone is not a mode catalog.
    expect(v.source).toBe("none");
    expect(v.availableModeIds).toEqual([]);
    expect(v.currentModeId).toBeUndefined();
  });

  test("Grok agent seeds builtin default/plan/ask (xai-org/grok-build SessionMode)", () => {
    const v = extractSessionModes({
      modes: null,
      agent: "grok-build",
      meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "high", category: "mode", selected: true },
            { id: "medium", category: "mode", selected: false },
          ],
        },
      },
    });
    expect(v.source).toBe("grok.builtin");
    expect(v.availableModeIds).toEqual(["default", "plan", "ask"]);
    expect(v.currentModeId).toBe("default");
    // Effort ids must not become current mode
    expect(v.currentModeId).not.toBe("high");
  });

  test("Grok prior plan mode is restored from store", () => {
    const v = extractSessionModes({
      agent: "grok-build",
      priorModeId: "plan",
    });
    expect(v.source).toBe("grok.builtin");
    expect(v.currentModeId).toBe("plan");
  });

  test("Grok prior effort id is ignored when seeding builtins", () => {
    const v = extractSessionModes({
      agent: "grok-build",
      priorModeId: "high",
    });
    expect(v.currentModeId).toBe("default");
  });

  test("ACP modes still win when present (ignore Grok meta)", () => {
    const v = extractSessionModes({
      modes: {
        availableModes: [{ id: "plan" }, { id: "build" }],
        currentModeId: "build",
      },
      meta: {
        "x.ai/sessionConfig": {
          options: [
            { id: "high", category: "mode", selected: true },
          ],
        },
      },
    });
    expect(v.source).toBe("acp.modes");
    expect(v.currentModeId).toBe("build");
  });

  test("empty when agent does not advertise modes", () => {
    const v = extractSessionModes({
      modes: undefined,
      meta: { currentWorkingDirectory: "/tmp" },
    });
    expect(v.source).toBe("none");
    expect(v.availableModeIds).toEqual([]);
    expect(v.currentModeId).toBeUndefined();
  });

  test("OpenCode configOptions Session Mode (build/plan)", () => {
    const v = extractSessionModes({
      modes: null,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "opencode/big-pickle",
          options: [{ value: "opencode/big-pickle", name: "Big Pickle" }],
        },
        {
          id: "mode",
          name: "Session Mode",
          type: "select",
          category: "mode",
          currentValue: "build",
          options: [
            { value: "build", name: "build" },
            { value: "plan", name: "plan" },
          ],
        },
      ],
    });
    expect(v.source).toBe("configOptions");
    expect(v.currentModeId).toBe("build");
    expect(v.availableModeIds).toEqual(["build", "plan"]);
  });

  test("configOptions mode high/medium/low is NOT permission modes", () => {
    const v = extractSessionModes({
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          category: "mode",
          currentValue: "high",
          options: [
            { value: "high", name: "High" },
            { value: "medium", name: "Medium" },
            { value: "low", name: "Low" },
          ],
        },
      ],
    });
    expect(v.source).toBe("none");
    expect(v.availableModeIds).toEqual([]);
  });
});

describe("formatSessionStatus mode line", () => {
  test("shows mode id when present", () => {
    const t = formatSessionStatus({
      sessionKey: "a/b",
      status: "done",
      agent: "codex",
      mode: "agent",
      availableModes: ["read-only", "agent"],
      cwd: "/tmp",
      threadId: 1,
      chatId: 2,
    });
    expect(t).toMatch(/Mode: `agent`/);
    expect(t).not.toMatch(/Mode: _\(not advertised/);
  });

  test("Grok: mode default + effort high are distinct", () => {
    const t = formatSessionStatus({
      sessionKey: "a/b",
      status: "done",
      agent: "grok-build",
      mode: "default",
      availableModes: ["default", "plan", "ask"],
      effort: "high",
      model: "Grok 4.5",
      cwd: "/tmp",
      threadId: 1,
      chatId: 2,
    });
    expect(t).toMatch(/Mode: `default`/);
    expect(t).toMatch(/Effort: `high`/);
    expect(t).toMatch(/Model: `Grok 4\.5`/);
    expect(t).toMatch(/Modes: \*\*default\*\*, plan, ask/);
  });

  test("shows not advertised when mode missing", () => {
    const t = formatSessionStatus({
      sessionKey: "a/b",
      status: "done",
      agent: "opencode",
      cwd: "/tmp",
      threadId: 1,
      chatId: 2,
    });
    expect(t).toMatch(/Mode: _\(not advertised\)_/);
    expect(t).not.toMatch(/Effort:/);
    expect(t).not.toMatch(/Mode: `unknown`/);
  });
});
