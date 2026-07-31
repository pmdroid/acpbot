import { describe, expect, test } from "bun:test";
import {
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
