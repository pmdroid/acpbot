/**
 * Always rewrite remote (http/sse) MCP descriptors into local stdio proxies.
 *
 * Per **session slot** (repo/name): the agent spawns its own `acpbot mcp-proxy`
 * child for each remote. Auth stays in acpbot; agents never do OAuth HTTP.
 */
import type { AcpbotMcpRemoteServer, SessionMcpServer } from "./repo-mcp";
import { acpbotSubArgs } from "./acpbot-spawn";

export type ProxyRewriteOptions = {
  stateDir: string;
  repoKey: string;
  /** Session key (repo/name) — one proxy process tree per slot. */
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Convert every remote http/sse server to a stdio `acpbot mcp-proxy` launch.
 * Stdio entries are left unchanged.
 *
 * Each resulting descriptor is bound to a single agent session: the host
 * passes this list at session/new|load, so each slot gets its own proxy
 * child processes (not a shared global proxy).
 */
export function rewriteRemotesAsStdioProxies(
  servers: SessionMcpServer[],
  options: ProxyRewriteOptions,
): SessionMcpServer[] {
  const { command, args: proxyArgs } = acpbotSubArgs(
    "mcp-proxy",
    [],
    options.env,
  );

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
    if (options.sessionKey?.trim()) {
      env.push({ name: "ACPBOT_SESSION_KEY", value: options.sessionKey.trim() });
    }
    return {
      name: remote.name,
      command,
      args: proxyArgs,
      env,
    };
  });
}
