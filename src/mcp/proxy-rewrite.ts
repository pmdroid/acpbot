/**
 * Rewrite remote (http/sse) MCP descriptors into local stdio proxies so agents
 * never speak OAuth HTTP to third parties — acpbot owns the Bearer token.
 */
import type { AcpbotMcpRemoteServer, SessionMcpServer } from "./repo-mcp";
import { acpbotSubArgs } from "./acpbot-spawn";

export type ProxyRewriteOptions = {
  stateDir: string;
  repoKey: string;
  /**
   * When true (default), remotes become stdio `acpbot mcp-proxy` children.
   * Set ACPBOT_MCP_PROXY=0 to pass raw http/sse to the agent again.
   */
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
};

export function mcpProxyEnabled(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  const v = env.ACPBOT_MCP_PROXY?.trim() || env.TACP_MCP_PROXY?.trim();
  if (v === "0" || v === "false" || v === "off") return false;
  // Default ON — agents (esp. Grok) struggle with remote OAuth MCP
  return true;
}

/**
 * Convert remote http/sse servers to stdio proxy launches.
 * Stdio entries are left unchanged.
 */
export function rewriteRemotesAsStdioProxies(
  servers: SessionMcpServer[],
  options: ProxyRewriteOptions,
): SessionMcpServer[] {
  if (!mcpProxyEnabled(options.env, options.enabled)) {
    return servers;
  }

  const { command, args: proxyArgs } = acpbotSubArgs("mcp-proxy", [], options.env);

  return servers.map((s) => {
    const type = (s as { type?: string }).type;
    if (type !== "http" && type !== "sse") return s;
    const remote = s as AcpbotMcpRemoteServer;
    const env: Array<{ name: string; value: string }> = [
      { name: "ACPBOT_STATE_DIR", value: options.stateDir },
      { name: "ACPBOT_REPO_KEY", value: options.repoKey },
      { name: "ACPBOT_MCP_PROXY_ID", value: remote.name },
      { name: "ACPBOT_MCP_PROXY_URL", value: remote.url },
      { name: "ACPBOT_MCP_PROXY_TYPE", value: remote.type },
    ];
    return {
      name: remote.name,
      command,
      args: proxyArgs,
      env,
    };
  });
}
