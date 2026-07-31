import { describe, expect, test } from "bun:test";
import {
  currentModelLabel,
  findModelConfigOption,
  formatModelStatus,
  modelsStateToConfigOptions,
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

  test("Grok SessionModelState (session/set_model) maps to model options", () => {
    // Shape from xai-org/grok-build SessionModelState / _x.ai/models/update
    const opts = modelsStateToConfigOptions({
      currentModelId: "grok-4.5",
      availableModels: [
        { modelId: "grok-4.5", name: "Grok 4.5" },
        { modelId: "grok-3", name: "Grok 3" },
      ],
    });
    expect(findModelConfigOption(opts)?.options.map((o) => o.value)).toEqual([
      "grok-4.5",
      "grok-3",
    ]);
    expect(currentModelLabel(opts)).toBe("Grok 4.5");
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
