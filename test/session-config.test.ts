import { describe, expect, test } from "bun:test";
import {
  currentModelLabel,
  findEffortConfigOption,
  findModeConfigOption,
  findModelConfigOption,
  formatEffortStatus,
  formatModelStatus,
  modelsStateToConfigOptions,
  normalizeConfigOptions,
  sessionConfigEffortToConfigOptions,
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

  test("Grok sessionConfig category mode → effort config options", () => {
    const opts = sessionConfigEffortToConfigOptions({
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
    });
    expect(findEffortConfigOption(opts)?.id).toBe("effort");
    expect(findEffortConfigOption(opts)?.options.map((o) => o.value)).toEqual([
      "high",
      "medium",
      "low",
    ]);
    expect(findEffortConfigOption(opts)?.currentValue).toBe("high");
    expect(formatEffortStatus({ configOptions: opts })).toMatch(/\*\*Effort:\*\* `high`/);
    expect(formatEffortStatus({ configOptions: opts })).toContain("`high`");
    expect(formatEffortStatus({ configOptions: opts })).not.toMatch(/Grok/i);
    // Model entries must not be treated as effort
    expect(findModelConfigOption(opts)).toBeUndefined();
  });

  test("empty effort when not advertised", () => {
    expect(findEffortConfigOption([])).toBeUndefined();
    expect(formatEffortStatus({ configOptions: [] })).toMatch(
      /does not advertise/,
    );
  });

  test("OpenCode mode config option (build/plan) is not effort", () => {
    const opts = normalizeConfigOptions([
      {
        id: "mode",
        name: "Session Mode",
        type: "select",
        category: "mode",
        currentValue: "build",
        options: [
          { value: "build", name: "build" },
          { value: "plan", name: "plan" },
        ],
      },
      {
        id: "effort",
        name: "Effort",
        type: "select",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "high", name: "High" },
          { value: "low", name: "Low" },
        ],
      },
    ]);
    expect(findModeConfigOption(opts)?.currentValue).toBe("build");
    expect(findEffortConfigOption(opts)?.id).toBe("effort");
    expect(findModeConfigOption(opts)?.options.map((o) => o.value)).toEqual([
      "build",
      "plan",
    ]);
  });
});

describe("listRegisteredAgents", () => {
  test("full registry via availableOnly false", () => {
    const ids = listRegisteredAgents({
      env: {},
      availableOnly: false,
      which: () => null,
    });
    expect(ids).toContain("grok-build");
    expect(ids).toContain("claude");
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("allowlist filters", () => {
    const ids = listRegisteredAgents({
      env: { ACPBOT_AGENTS: "grok-build" },
      availableOnly: false,
    });
    expect(ids).toEqual(["grok-build"]);
  });
});
