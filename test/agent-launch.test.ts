import { describe, expect, test } from "bun:test";
import {
  agentDisplayName,
  agentSelectOptions,
  isAgentAvailable,
  listKnownAgentIds,
  listRegisteredAgents,
  normalizeAgentName,
  requiredBinsForAgent,
  resolveAgentLaunch,
  resolveAgentLaunchForSpawn,
  resolveLaunchCommandPath,
  type WhichFn,
} from "../src/acp/agent-launch";

describe("agent-launch", () => {
  test("claude-code normalizes to claude adapter", () => {
    expect(normalizeAgentName("claude-code")).toBe("claude");
    const launch = resolveAgentLaunch("claude");
    expect(launch.command).toBe("npx");
    expect(launch.args.join(" ")).toContain(
      "@agentclientprotocol/claude-agent-acp@0.64.0",
    );
  });

  test("codex uses codex-acp adapter not codex acp", () => {
    const launch = resolveAgentLaunch("codex");
    expect(launch.command).toBe("npx");
    expect(launch.args.join(" ")).toContain(
      "@agentclientprotocol/codex-acp@1.1.7",
    );
    expect(launch.args).not.toContain("acp");
  });

  test("adapter package pins can be overridden via env", () => {
    const claude = resolveAgentLaunch("claude", {
      ACPBOT_CLAUDE_ACP_PKG: "@agentclientprotocol/claude-agent-acp@9.9.9",
    });
    expect(claude.args).toContain(
      "@agentclientprotocol/claude-agent-acp@9.9.9",
    );
    const codex = resolveAgentLaunch("codex", {
      ACPBOT_CODEX_ACP_PKG: "@agentclientprotocol/codex-acp@8.8.8",
    });
    expect(codex.args).toContain("@agentclientprotocol/codex-acp@8.8.8");
  });

  test("grok-build keeps native stdio", () => {
    const launch = resolveAgentLaunch("grok-build");
    expect(launch).toEqual({ command: "grok", args: ["agent", "stdio"] });
  });

  test("grok-build always-approve injects flag", () => {
    const launch = resolveAgentLaunch("grok-build", process.env, {
      alwaysApprove: true,
    });
    expect(launch.args).toEqual(["agent", "--always-approve", "stdio"]);
  });

  test("resolveLaunchCommandPath looks up bare names", () => {
    const which: WhichFn = (cmd) =>
      cmd === "grok" ? "/Users/me/.grok/bin/grok" : null;
    expect(resolveLaunchCommandPath("grok", which)).toBe(
      "/Users/me/.grok/bin/grok",
    );
    expect(resolveLaunchCommandPath("missing", which)).toBeNull();
  });

  test("resolveAgentLaunchForSpawn uses absolute path or throws", () => {
    const which: WhichFn = (cmd) =>
      cmd === "grok" ? "/Users/me/.grok/bin/grok" : null;
    const launch = resolveAgentLaunchForSpawn("grok-build", {}, which);
    expect(launch).toEqual({
      command: "/Users/me/.grok/bin/grok",
      args: ["agent", "stdio"],
    });
    expect(() => resolveAgentLaunchForSpawn("codex", {}, which)).toThrow(
      /not found on PATH/,
    );
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

  test("ACPBOT_AGENTS_ALL lists full registry ignoring PATH", () => {
    const ids = listRegisteredAgents({
      env: { ACPBOT_AGENTS_ALL: "1" },
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
      env: { ACPBOT_AGENTS: "grok, opencode, codex" },
      which,
    });
    // codex not installed; grok normalizes to grok-build
    expect(ids).toEqual(["grok-build", "opencode"]);
  });

  test("allowlist with ACPBOT_AGENTS_ALL still respects allowlist", () => {
    const ids = listRegisteredAgents({
      env: { ACPBOT_AGENTS: "claude", ACPBOT_AGENTS_ALL: "1" },
      which: () => null,
    });
    expect(ids).toEqual(["claude"]);
  });

  test("overrides with missing command are filtered", () => {
    const ids = listRegisteredAgents({
      env: {
        ACPBOT_AGENT_COMMAND_JSON: JSON.stringify({
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
        ACPBOT_AGENT_COMMAND_JSON: JSON.stringify({
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

  test("agentSelectOptions only lists PATH-available agents", () => {
    const whichLocal: WhichFn = (cmd) =>
      cmd === "grok" || cmd === "opencode" ? `/usr/bin/${cmd}` : null;
    const pick = agentSelectOptions({ which: whichLocal });
    expect(pick.noneInstalled).toBe(false);
    expect(pick.agents).toEqual(["grok-build", "opencode"]);
    expect(pick.options.map((o) => o.value)).toEqual([
      "grok-build",
      "opencode",
    ]);
    expect(pick.options[0]!.label).toBe("Grok Build");
    expect(pick.options[1]!.label).toBe("OpenCode");
    // Claude/Codex need npx+cli — absent
    expect(pick.agents).not.toContain("claude");
    expect(pick.agents).not.toContain("codex");
  });

  test("agentSelectOptions noneInstalled when PATH empty", () => {
    const pick = agentSelectOptions({ which: () => null });
    expect(pick.noneInstalled).toBe(true);
    expect(pick.agents).toEqual([]);
    expect(pick.options).toEqual([]);
  });

  test("agentSelectOptions availableOnly false shows full registry", () => {
    const pick = agentSelectOptions({
      which: () => null,
      availableOnly: false,
    });
    expect(pick.noneInstalled).toBe(false);
    expect(pick.agents).toContain("grok-build");
    expect(pick.agents).toContain("claude");
    expect(pick.options.some((o) => o.hint.includes("not on PATH"))).toBe(
      true,
    );
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
