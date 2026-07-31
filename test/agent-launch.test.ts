import { describe, expect, test } from "bun:test";
import {
  agentDisplayName,
  isAgentAvailable,
  listKnownAgentIds,
  listRegisteredAgents,
  normalizeAgentName,
  requiredBinsForAgent,
  resolveAgentLaunch,
  type WhichFn,
} from "../src/acp/agent-launch";

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

  test("display names are human-friendly", () => {
    expect(agentDisplayName("grok-build")).toBe("grok");
    expect(agentDisplayName("grok")).toBe("grok");
    expect(agentDisplayName("opencode-ai")).toBe("opencode");
    expect(agentDisplayName("claude-code")).toBe("claude");
  });
});

describe("listRegisteredAgents availability", () => {
  const present = new Set(["grok", "opencode", "npx", "claude"]);
  const which: WhichFn = (cmd) => (present.has(cmd) ? `/bin/${cmd}` : null);

  test("known registry has unique canonical ids", () => {
    const ids = listKnownAgentIds({});
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["grok-build", "claude", "codex", "opencode"]);
    expect(ids.filter((id) => id.includes("opencode"))).toEqual(["opencode"]);
  });

  test("only lists agents whose required bins exist", () => {
    const ids = listRegisteredAgents({ env: {}, which });
    // codex missing from present set
    expect(ids).toEqual(["grok-build", "claude", "opencode"]);
    expect(ids).not.toContain("codex");
  });

  test("empty PATH yields empty picker list", () => {
    const ids = listRegisteredAgents({
      env: {},
      which: () => null,
    });
    expect(ids).toEqual([]);
  });

  test("TACP_AGENTS_ALL lists full registry ignoring PATH", () => {
    const ids = listRegisteredAgents({
      env: { TACP_AGENTS_ALL: "1" },
      which: () => null,
    });
    expect(ids).toEqual(["grok-build", "claude", "codex", "opencode"]);
  });

  test("availableOnly false lists full registry", () => {
    const ids = listRegisteredAgents({
      env: {},
      which: () => null,
      availableOnly: false,
    });
    expect(ids).toEqual(["grok-build", "claude", "codex", "opencode"]);
  });

  test("allowlist intersects installed agents", () => {
    const ids = listRegisteredAgents({
      env: { TACP_AGENTS: "grok, opencode, codex" },
      which,
    });
    // codex not installed; grok normalizes to grok-build
    expect(ids).toEqual(["grok-build", "opencode"]);
  });

  test("allowlist with TACP_AGENTS_ALL still respects allowlist", () => {
    const ids = listRegisteredAgents({
      env: { TACP_AGENTS: "claude", TACP_AGENTS_ALL: "1" },
      which: () => null,
    });
    expect(ids).toEqual(["claude"]);
  });

  test("overrides with missing command are filtered", () => {
    const ids = listRegisteredAgents({
      env: {
        TACP_AGENT_COMMAND_JSON: JSON.stringify({
          custom: { command: "my-custom-acp", args: [] },
        }),
      },
      which: (cmd) => (cmd === "grok" ? "/bin/grok" : null),
    });
    expect(ids).toContain("grok-build");
    expect(ids).not.toContain("custom");
  });

  test("overrides with present command appear once", () => {
    const ids = listRegisteredAgents({
      env: {
        TACP_AGENT_COMMAND_JSON: JSON.stringify({
          "My-Custom": { command: "my-custom-acp", args: ["stdio"] },
          "my-custom": { command: "my-custom-acp", args: ["stdio"] },
        }),
      },
      which: (cmd) =>
        cmd === "my-custom-acp" || cmd === "grok" ? `/bin/${cmd}` : null,
    });
    expect(ids.filter((id) => id === "my-custom")).toEqual(["my-custom"]);
    expect(ids).toContain("grok-build");
  });

  test("isAgentAvailable + requiredBins", () => {
    expect(requiredBinsForAgent("grok-build")).toEqual(["grok"]);
    expect(requiredBinsForAgent("claude")).toEqual(["npx", "claude"]);
    expect(isAgentAvailable("opencode", { which })).toBe(true);
    expect(isAgentAvailable("codex", { which })).toBe(false);
  });

  test("no duplicates under real PATH", () => {
    const ids = listRegisteredAgents();
    expect(new Set(ids).size).toBe(ids.length);
    // On this machine we expect at least grok + opencode when installed
    for (const id of ids) {
      expect(isAgentAvailable(id)).toBe(true);
    }
  });
});
