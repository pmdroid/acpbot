import { describe, expect, test } from "bun:test";
import {
  normalizeAgentName,
  resolveAgentLaunch,
} from "../src/acp/agent-launch";

describe("agent-launch", () => {
  test("normalizeAgentName", () => {
    expect(normalizeAgentName("grok")).toBe("grok-build");
    expect(normalizeAgentName("Grok-Build")).toBe("grok-build");
  });

  test("resolveAgentLaunch builtins", () => {
    expect(resolveAgentLaunch("grok-build")).toEqual({
      command: "grok",
      args: ["agent", "stdio"],
    });
  });

  test("resolveAgentLaunch override env", () => {
    const launch = resolveAgentLaunch("grok-build", {
      TACP_AGENT_COMMAND_JSON: JSON.stringify({
        "grok-build": { command: "/bin/echo", args: ["acp"] },
      }),
    });
    expect(launch).toEqual({ command: "/bin/echo", args: ["acp"] });
  });
});
