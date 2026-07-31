import { describe, expect, test } from "bun:test";
import {
  buildTacpMcpServers,
  defaultTacpMcpServerEntry,
} from "../src/mcp/servers";
import { buildAcpRuntimeOptions } from "../src/env/real-agents";
import { existsSync } from "node:fs";

describe("buildTacpMcpServers", () => {
  test("returns stdio tacp server with bun entry", () => {
    const servers = buildTacpMcpServers({ enabled: true });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("tacp");
    expect(servers[0]?.command).toBe(process.execPath);
    expect(servers[0]?.args[0]).toBe(defaultTacpMcpServerEntry());
    expect(existsSync(servers[0]!.args[0]!)).toBe(true);
    expect(Array.isArray(servers[0]?.env)).toBe(true);
  });

  test("disabled returns empty", () => {
    expect(buildTacpMcpServers({ enabled: false })).toEqual([]);
  });
});

describe("buildAcpRuntimeOptions mcpServers", () => {
  test("includes tacp MCP by default", () => {
    const opts = buildAcpRuntimeOptions({
      config: { operatorUserId: 1, repos: { t: "/r" } },
      acpxStateDir: "/state",
      sessionStore: {},
      agentRegistry: {},
      onPermissionRequest: async () => ({ outcome: "reject_once" }),
      onElicitationRequest: async () => ({ action: "decline" }),
    });
    const mcp = opts.mcpServers as Array<{ name: string; command: string }>;
    expect(Array.isArray(mcp)).toBe(true);
    expect(mcp.some((s) => s.name === "tacp")).toBe(true);
  });

  test("respects config.mcpEnabled false", () => {
    const opts = buildAcpRuntimeOptions({
      config: { operatorUserId: 1, mcpEnabled: false },
      acpxStateDir: "/state",
      sessionStore: {},
      agentRegistry: {},
      onPermissionRequest: async () => ({ outcome: "reject_once" }),
      onElicitationRequest: async () => ({ action: "decline" }),
    });
    expect(opts.mcpServers).toEqual([]);
  });

  test("explicit mcpServers override wins", () => {
    const opts = buildAcpRuntimeOptions({
      config: { operatorUserId: 1 },
      acpxStateDir: "/state",
      sessionStore: {},
      agentRegistry: {},
      onPermissionRequest: async () => ({ outcome: "reject_once" }),
      onElicitationRequest: async () => ({ action: "decline" }),
      mcpServers: [{ name: "custom", command: "echo", args: [], env: [] }],
    });
    expect(opts.mcpServers).toEqual([
      { name: "custom", command: "echo", args: [], env: [] },
    ]);
  });
});
