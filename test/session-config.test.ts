import { describe, expect, test } from "bun:test";
import {
  currentModelLabel,
  findModelConfigOption,
  formatModelStatus,
  normalizeConfigOptions,
} from "../src/acp/session-config";
import { listRegisteredAgents } from "../src/acp/agent-launch";

describe("session-config", () => {
  test("normalize + find model option", () => {
    const opts = normalizeConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: "fast",
        options: [
          { value: "fast", name: "Fast" },
          { value: "smart", name: "Smart" },
        ],
      },
    ]);
    expect(findModelConfigOption(opts)?.id).toBe("model");
    expect(currentModelLabel(opts)).toBe("Fast");
    expect(formatModelStatus({ configOptions: opts })).toContain("fast");
  });

  test("empty when no model options", () => {
    expect(findModelConfigOption([])).toBeUndefined();
    expect(formatModelStatus({ configOptions: [] })).toMatch(/does not advertise/);
  });
});

describe("listRegisteredAgents", () => {
  test("includes builtins", () => {
    const ids = listRegisteredAgents({});
    expect(ids).toContain("grok-build");
    expect(ids).toContain("claude");
  });

  test("allowlist filters", () => {
    const ids = listRegisteredAgents({ TACP_AGENTS: "grok-build" });
    expect(ids).toEqual(["grok-build"]);
  });
});
