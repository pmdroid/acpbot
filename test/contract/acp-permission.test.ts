/**
 * Contract: SessionHost surface + permission mapping (client half of ACP).
 * Live agent capability matrix: acp-capabilities.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createSessionHost } from "../../src/acp/session-host";
import { decisionToPermissionResponse } from "../../src/acp/permission-map";

describe("contract: SessionHost API surface", () => {
  test("createSessionHost exposes every method acpbot uses for agents", () => {
    const host = createSessionHost({
      config: { operatorUserId: 1 },
    });
    const methods = [
      "ensureSession",
      "startTurn",
      "cancel",
      "setMode",
      "getModeState",
      "getAvailableModes",
      "getConfigOptions",
      "setConfigOption",
      "disposeSession",
      "setHooks",
      "dispose",
    ] as const;
    for (const m of methods) {
      expect(typeof host[m]).toBe("function");
    }
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

  test("permission allow_always prefers allow_always option", () => {
    const res = decisionToPermissionResponse(
      [
        { optionId: "once", kind: "allow_once" },
        { optionId: "always", kind: "allow_always" },
      ],
      { outcome: "allow_always" },
    );
    expect(res).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
  });
});

