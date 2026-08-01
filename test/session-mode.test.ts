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

  test("Grok x.ai/sessionConfig effort modes", () => {
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
    expect(v.source).toBe("x.ai/sessionConfig");
    expect(v.currentModeId).toBe("high");
    expect(v.availableModeIds).toEqual(["high", "medium", "low"]);
  });

  test("ACP modes win over Grok meta when both present", () => {
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

  test("empty when agent does not advertise modes (OpenCode-like)", () => {
    const v = extractSessionModes({
      modes: undefined,
      meta: { currentWorkingDirectory: "/tmp" },
    });
    expect(v.source).toBe("none");
    expect(v.availableModeIds).toEqual([]);
    expect(v.currentModeId).toBeUndefined();
  });
});

describe("formatSessionStatus mode line", () => {
  test("shows mode id when present", () => {
    const t = formatSessionStatus({
      sessionKey: "a/b",
      status: "done",
      agent: "grok-build",
      mode: "high",
      availableModes: ["high", "medium", "low"],
      cwd: "/tmp",
      threadId: 1,
      chatId: 2,
    });
    expect(t).toMatch(/Mode: `high`/);
    expect(t).not.toMatch(/Mode: _\(not advertised/);
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
    expect(t).toMatch(/Mode: _\(not advertised/);
    expect(t).not.toMatch(/Mode: `unknown`/);
  });
});
