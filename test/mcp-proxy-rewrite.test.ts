import { describe, expect, test } from "bun:test";
import { rewriteRemotesAsStdioProxies } from "../src/mcp/proxy-rewrite";
import type { SessionMcpServer } from "../src/mcp/repo-mcp";

describe("mcp proxy rewrite", () => {
  test("always converts http/sse to per-slot stdio proxy", () => {
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
      sessionKey: "work/arcade",
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
    const env = Object.fromEntries(proxy.env.map((e) => [e.name, e.value]));
    expect(env.ACPBOT_MCP_PROXY_ID).toBe("full");
    expect(env.ACPBOT_MCP_PROXY_URL).toBe("https://api.example/mcp/gw");
    expect(env.ACPBOT_REPO_KEY).toBe("work");
    expect(env.ACPBOT_SESSION_KEY).toBe("work/arcade");
    // stdio entry unchanged
    expect(out[1]).toEqual(servers[1]);
  });

  test("two slots get independent env (sessionKey)", () => {
    const remote: SessionMcpServer = {
      type: "http",
      name: "full",
      url: "https://api.example/mcp",
      headers: [],
    };
    const a = rewriteRemotesAsStdioProxies([remote], {
      stateDir: "/tmp/state",
      repoKey: "work",
      sessionKey: "work/a",
      env: { ACPBOT_BIN: "/bin/acpbot" },
    });
    const b = rewriteRemotesAsStdioProxies([remote], {
      stateDir: "/tmp/state",
      repoKey: "work",
      sessionKey: "work/b",
      env: { ACPBOT_BIN: "/bin/acpbot" },
    });
    const envA = Object.fromEntries(
      (a[0] as { env: Array<{ name: string; value: string }> }).env.map((e) => [
        e.name,
        e.value,
      ]),
    );
    const envB = Object.fromEntries(
      (b[0] as { env: Array<{ name: string; value: string }> }).env.map((e) => [
        e.name,
        e.value,
      ]),
    );
    expect(envA.ACPBOT_SESSION_KEY).toBe("work/a");
    expect(envB.ACPBOT_SESSION_KEY).toBe("work/b");
    // Same gateway/token key, different slot processes
    expect(envA.ACPBOT_MCP_PROXY_ID).toBe(envB.ACPBOT_MCP_PROXY_ID);
  });
});
