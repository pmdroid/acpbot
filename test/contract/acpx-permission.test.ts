/**
 * Contract: thin ACP host entry points exist.
 * (Replaced acpx/runtime contract after SDK migration.)
 */
import { describe, expect, test } from "bun:test";
import { createSessionHost } from "../../src/acp/session-host";
import { decisionToPermissionResponse } from "../../src/acp/permission-map";

describe("contract: acp-sdk host", () => {
  test("createSessionHost returns ensureSession/startTurn", () => {
    const host = createSessionHost({
      config: { operatorUserId: 1 },
    });
    expect(typeof host.ensureSession).toBe("function");
    expect(typeof host.startTurn).toBe("function");
    expect(typeof host.cancel).toBe("function");
  });

  test("permission mapping is deterministic", () => {
    const res = decisionToPermissionResponse(
      [{ optionId: "ok", kind: "allow_once" }],
      { outcome: "allow_once" },
    );
    expect(res).toEqual({
      outcome: { outcome: "selected", optionId: "ok" },
    });
  });
});
