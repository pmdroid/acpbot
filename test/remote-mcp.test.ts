import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSessionMcpServers } from "../src/mcp/repo-mcp";
import { remoteMcpEnabled } from "../src/mcp/remote-mcp";
import { maybeStartOauthHttpServer } from "../src/acp-host/oauth-http";
import { loadConfig } from "../src/config";

describe("remoteMcpEnabled", () => {
  test("default off; 1/true on", () => {
    expect(remoteMcpEnabled({})).toBe(false);
    expect(remoteMcpEnabled({ TACP_REMOTE_MCP: "1" })).toBe(true);
    expect(remoteMcpEnabled({ TACP_REMOTE_MCP: "true" })).toBe(true);
    expect(remoteMcpEnabled({ TACP_REMOTE_MCP: "0" })).toBe(false);
    expect(remoteMcpEnabled({}, true)).toBe(true);
    expect(remoteMcpEnabled({ TACP_REMOTE_MCP: "1" }, false)).toBe(false);
  });
});

describe("loadConfig remoteMcpEnabled", () => {
  test("reads TACP_REMOTE_MCP", () => {
    const base = {
      TACP_BOT_TOKEN: "t",
      TACP_OPERATOR_USER_ID: "1",
      TACP_STORE_PATH: "/tmp/s.json",
      TACP_STATE_DIR: "/tmp/state",
    };
    expect(loadConfig({ env: { ...base } }).remoteMcpEnabled).toBe(false);
    expect(
      loadConfig({ env: { ...base, TACP_REMOTE_MCP: "1" } }).remoteMcpEnabled,
    ).toBe(true);
  });
});

describe("buildSessionMcpServers remote gate", () => {
  test("drops http remotes when remote MCP disabled", async () => {
    const repo = await mkdtemp(join(tmpdir(), "tacp-remote-off-"));
    try {
      await mkdir(join(repo, ".tacp"), { recursive: true });
      await writeFile(
        join(repo, ".tacp", "mcp.json"),
        JSON.stringify({
          mcpServers: [
            {
              name: "local",
              command: "bun",
              args: ["run", ".tacp/x.ts"],
            },
            {
              name: "remote",
              type: "http",
              url: "https://example.com/mcp",
            },
          ],
        }),
        "utf8",
      );
      const servers = await buildSessionMcpServers({
        cwd: repo,
        enabled: true,
        sessionKey: "demo/t",
        stateDir: "/tmp/host-state",
        remoteMcpEnabled: false,
      });
      const names = servers.map((s) => (s as { name: string }).name);
      expect(names).toContain("local");
      expect(names).toContain("tacp");
      expect(names).not.toContain("remote");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("keeps http remotes when remote MCP enabled", async () => {
    const repo = await mkdtemp(join(tmpdir(), "tacp-remote-on-"));
    try {
      await mkdir(join(repo, ".tacp"), { recursive: true });
      await writeFile(
        join(repo, ".tacp", "mcp.json"),
        JSON.stringify({
          mcpServers: [
            {
              name: "remote",
              type: "http",
              url: "https://example.com/mcp",
            },
          ],
        }),
        "utf8",
      );
      const servers = await buildSessionMcpServers({
        cwd: repo,
        enabled: true,
        sessionKey: "demo/t",
        stateDir: "/tmp/host-state",
        remoteMcpEnabled: true,
        oauthFailClosed: false,
      });
      const names = servers.map((s) => (s as { name: string }).name);
      expect(names).toContain("remote");
      expect(names).toContain("tacp");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("maybeStartOauthHttpServer gate", () => {
  test("does not start when remote MCP is off even with callback base", async () => {
    const r = await maybeStartOauthHttpServer({
      env: {
        TACP_OAUTH_CALLBACK_BASE: "https://example.ts.net",
        TACP_REMOTE_MCP: "0",
      },
      stateDir: "/tmp/oauth-state",
    });
    expect(r).toBeNull();
  });
});
