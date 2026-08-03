import { describe, expect, test } from "bun:test";
import {
  mcpProxyEnabled,
  rewriteRemotesAsStdioProxies,
} from "../src/mcp/proxy-rewrite";
import type { SessionMcpServer } from "../src/mcp/repo-mcp";

describe("mcp proxy rewrite", () => {
  test("mcpProxyEnabled defaults true", () => {
    expect(mcpProxyEnabled({})).toBe(true);
    expect(mcpProxyEnabled({ ACPBOT_MCP_PROXY: "0" })).toBe(false);
    expect(mcpProxyEnabled({ ACPBOT_MCP_PROXY: "false" })).toBe(false);
    expect(mcpProxyEnabled({}, false)).toBe(false);
    expect(mcpProxyEnabled({ ACPBOT_MCP_PROXY: "0" }, true)).toBe(true);
  });

  test("rewriteRemotesAsStdioProxies converts http/sse only", () => {
    const servers: SessionMcpServer[] = [
      {
        type: "http",
        name: "full",
        url: "https://api.example/mcp/gw",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      },
      {
        name: "local",
        command: "bun",
        args: ["run", "tool.ts"],
        env: [],
      },
    ];
    const out = rewriteRemotesAsStdioProxies(servers, {
      stateDir: "/tmp/state",
      repoKey: "work",
      env: { ACPBOT_BIN: "/usr/local/bin/acpbot" },
    });
    expect(out).toHaveLength(2);
    const proxy = out[0] as {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };
    expect(proxy.name).toBe("full");
    expect(proxy.command).toBe("/usr/local/bin/acpbot");
    expect(proxy.args).toContain("mcp-proxy");
    expect(proxy.env).toContainEqual({
      name: "ACPBOT_MCP_PROXY_ID",
      value: "full",
    });
    expect(proxy.env).toContainEqual({
      name: "ACPBOT_MCP_PROXY_URL",
      value: "https://api.example/mcp/gw",
    });
    expect(proxy.env).toContainEqual({
      name: "ACPBOT_REPO_KEY",
      value: "work",
    });
    // stdio entry unchanged
    expect(out[1]).toEqual(servers[1]);
  });

  test("disabled leaves remotes as http", () => {
    const servers: SessionMcpServer[] = [
      {
        type: "http",
        name: "full",
        url: "https://api.example/mcp",
        headers: [],
      },
    ];
    const out = rewriteRemotesAsStdioProxies(servers, {
      stateDir: "/tmp/state",
      repoKey: "work",
      enabled: false,
    });
    expect(out[0]).toEqual(servers[0]);
  });
});
