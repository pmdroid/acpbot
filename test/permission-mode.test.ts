import { describe, expect, test } from "bun:test";
import {
  formatPermissionStatus,
  parsePermissionMode,
  permissionModeLabel,
} from "../src/acp/permission-mode";
import { applyAlwaysApproveArgs } from "../src/acp/agent-launch";
import { loadConfig } from "../src/config";

describe("parsePermissionMode", () => {
  test("maps aliases to ask | bypass", () => {
    expect(parsePermissionMode("ask")).toBe("ask");
    expect(parsePermissionMode("prompt")).toBe("ask");
    expect(parsePermissionMode("bypass")).toBe("bypass");
    expect(parsePermissionMode("always")).toBe("bypass");
    expect(parsePermissionMode("always-approve")).toBe("bypass");
    expect(parsePermissionMode("yolo")).toBe("bypass");
    expect(parsePermissionMode("nope")).toBeUndefined();
  });
});

describe("formatPermissionStatus", () => {
  test("shows default and session", () => {
    const t = formatPermissionStatus({
      defaultMode: "ask",
      session: "bypass",
    });
    expect(t).toMatch(/Default.*`ask`/);
    expect(t).toMatch(/This topic.*`bypass`/);
  });
});

describe("applyAlwaysApproveArgs", () => {
  test("inserts --always-approve before stdio for grok", () => {
    const launch = applyAlwaysApproveArgs("grok-build", {
      command: "grok",
      args: ["agent", "stdio"],
    });
    expect(launch.args).toEqual(["agent", "--always-approve", "stdio"]);
  });

  test("idempotent", () => {
    const launch = applyAlwaysApproveArgs("grok-build", {
      command: "grok",
      args: ["agent", "--always-approve", "stdio"],
    });
    expect(launch.args).toEqual(["agent", "--always-approve", "stdio"]);
  });

  test("leaves claude unchanged", () => {
    const launch = applyAlwaysApproveArgs("claude", {
      command: "npx",
      args: ["-y", "pkg"],
    });
    expect(launch.args).toEqual(["-y", "pkg"]);
  });
});

describe("loadConfig permission_mode", () => {
  test("features.permission_mode bypass", () => {
    const cfg = loadConfig({
      skipFile: true,
      requireTelegram: false,
      file: {
        botToken: "t",
        operatorUserId: 1,
        features: { permission_mode: "bypass" },
      },
    });
    expect(cfg.permissionMode).toBe("bypass");
  });

  test("always-approve alias still loads as bypass", () => {
    const cfg = loadConfig({
      skipFile: true,
      requireTelegram: false,
      file: {
        botToken: "t",
        operatorUserId: 1,
        features: { permission_mode: "always-approve" },
      },
    });
    expect(cfg.permissionMode).toBe("bypass");
  });

  test("defaults to ask", () => {
    const cfg = loadConfig({
      skipFile: true,
      requireTelegram: false,
      file: { botToken: "t", operatorUserId: 1 },
    });
    expect(cfg.permissionMode).toBe("ask");
  });
});

describe("permissionModeLabel", () => {
  test("labels", () => {
    expect(permissionModeLabel("ask")).toBe("ask");
    expect(permissionModeLabel("bypass")).toBe("bypass");
  });
});
