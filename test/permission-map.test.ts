import { describe, expect, test } from "bun:test";
import {
  decisionToPermissionResponse,
  isPlanExitPermission,
  isComputerUsePermission,
  shouldForceAskPermission,
} from "../src/acp/permission-map";

describe("decisionToPermissionResponse", () => {
  const options = [
    { optionId: "a1", kind: "allow_once", name: "Allow" },
    { optionId: "r1", kind: "reject_once", name: "Deny" },
  ];

  test("maps allow_once to selected optionId", () => {
    expect(
      decisionToPermissionResponse(options, { outcome: "allow_once" }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });

  test("cancel → cancelled", () => {
    expect(
      decisionToPermissionResponse(options, { outcome: "cancel" }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("reject_once → reject option", () => {
    expect(
      decisionToPermissionResponse(options, { outcome: "reject_once" }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  test("falls back to Approve name when kinds missing (plan exit)", () => {
    const planOpts = [
      { optionId: "approve", name: "Approve plan" },
      { optionId: "reject", name: "Keep planning" },
    ];
    expect(
      decisionToPermissionResponse(planOpts, { outcome: "allow_once" }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "approve" } });
    expect(
      decisionToPermissionResponse(planOpts, { outcome: "allow_always" }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "approve" } });
  });
});

describe("isPlanExitPermission", () => {
  test("detects exit_plan_mode title", () => {
    expect(
      isPlanExitPermission({
        toolCall: { title: "exit_plan_mode", kind: "other" },
      }),
    ).toBe(true);
  });

  test("detects Plan: Exit title", () => {
    expect(
      isPlanExitPermission({
        toolCall: { title: "Plan: Exit", rawInput: { variant: "ExitPlanMode" } },
      }),
    ).toBe(true);
  });

  test("detects ExitPlanMode variant", () => {
    expect(
      isPlanExitPermission({
        toolCall: { title: "other", rawInput: { variant: "ExitPlanMode" } },
      }),
    ).toBe(true);
  });

  test("ordinary tool is not plan exit", () => {
    expect(
      isPlanExitPermission({
        toolCall: { title: "run_terminal_command", kind: "execute" },
      }),
    ).toBe(false);
  });
});

describe("isComputerUsePermission", () => {
  test("detects computer_screenshot", () => {
    expect(
      isComputerUsePermission({
        toolCall: { title: "computer_screenshot" },
      }),
    ).toBe(true);
    expect(shouldForceAskPermission({ toolCall: { title: "computer_click" } })).toBe(
      true,
    );
  });
});
