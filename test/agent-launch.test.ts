import { describe, expect, test } from "bun:test";
import {
  listRegisteredAgents,
  normalizeAgentName,
  resolveAgentLaunch,
} from "../src/acp/agent-launch";
import {
  applyModelToLaunch,
  getCannedModelsForAgent,
} from "../src/acp/agent-models";

describe("agent-launch", () => {
  test("claude-code normalizes to claude adapter", () => {
    expect(normalizeAgentName("claude-code")).toBe("claude");
    const launch = resolveAgentLaunch("claude");
    expect(launch.command).toBe("npx");
    expect(launch.args.join(" ")).toContain("claude-agent-acp");
  });

  test("codex uses codex-acp adapter not codex acp", () => {
    const launch = resolveAgentLaunch("codex");
    expect(launch.command).toBe("npx");
    expect(launch.args.join(" ")).toContain("codex-acp");
    expect(launch.args).not.toContain("acp");
  });

  test("grok-build keeps native stdio", () => {
    const launch = resolveAgentLaunch("grok-build");
    expect(launch).toEqual({ command: "grok", args: ["agent", "stdio"] });
  });

  test("opencode uses native acp subcommand", () => {
    expect(normalizeAgentName("opencode-ai")).toBe("opencode");
    const launch = resolveAgentLaunch("opencode");
    expect(launch).toEqual({ command: "opencode", args: ["acp"] });
  });
});

describe("agent-models canned", () => {
  test("grok has canned models", () => {
    const m = getCannedModelsForAgent("grok-build");
    expect(m.length).toBeGreaterThan(0);
    expect(m.some((x) => x.value.includes("grok"))).toBe(true);
  });

  test("applyModelToLaunch adds -m for grok", () => {
    const base = { command: "grok", args: ["agent", "stdio"] };
    const next = applyModelToLaunch("grok-build", base, "grok-3-mini");
    expect(next.args).toEqual(["agent", "stdio", "-m", "grok-3-mini"]);
  });
});

describe("listRegisteredAgents", () => {
  test("includes grok-build claude codex opencode", () => {
    const ids = listRegisteredAgents({});
    expect(ids).toContain("grok-build");
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("opencode");
  });
});
