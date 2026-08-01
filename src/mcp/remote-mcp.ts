/**
 * Remote (http/sse) MCP + OAuth is an optional product layer.
 * Built-in `tacp` host tools and local stdio MCP stay always available.
 *
 * Enable with: TACP_REMOTE_MCP=1
 */
export function remoteMcpEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  const v = env.TACP_REMOTE_MCP?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export const REMOTE_MCP_DISABLED_HINT =
  "Remote MCP (http/sse) and OAuth are disabled. Set `TACP_REMOTE_MCP=1` to enable, then restart worker + acp-host.";
