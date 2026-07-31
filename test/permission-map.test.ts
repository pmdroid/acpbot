import { describe, expect, test } from "bun:test";
import { decisionToPermissionResponse } from "../src/acp/permission-map";

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
});
